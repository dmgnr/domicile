//! Gets the desk a certificate for its relay address from an ACME
//! certificate authority such as Let's Encrypt (RFC 8555), proving it holds
//! the address with TLS-ALPN-01 (RFC 8737): the authority connects to the
//! address, which the relay passes to the desk, and the desk answers with a
//! certificate carrying the challenge. The desk alone holds the key, so the
//! relay can't read what agents say. See `docs/AGENTS.md`.

use std::io;

use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::oauth::base64url;

/// One HTTP answer, as ACME reads it.
pub(super) struct Answer {
    pub status: u16,
    pub location: Option<String>,
    /// The `Replay-Nonce` header, which the next request signs.
    pub nonce: Option<String>,
    pub body: Vec<u8>,
}

/// HTTPS to the authority.
pub(super) trait Http {
    fn head(&mut self, url: &str) -> io::Result<Answer>;
    fn get(&mut self, url: &str) -> io::Result<Answer>;
    /// POSTs `body` as `application/jose+json`.
    fn post(&mut self, url: &str, body: &[u8]) -> io::Result<Answer>;
}

/// The key the desk's ACME account is, a P-256 key kept as PKCS#8.
pub(super) struct AccountKey {
    pair: EcdsaKeyPair,
    pkcs8: Vec<u8>,
}

impl AccountKey {
    pub(super) fn generate() -> AccountKey {
        let random = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &random)
            .expect("the system makes keys");
        AccountKey::from_pkcs8(pkcs8.as_ref()).expect("a key it made reads back")
    }

    pub(super) fn from_pkcs8(pkcs8: &[u8]) -> Option<AccountKey> {
        let pair = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8,
            &SystemRandom::new(),
        )
        .ok()?;
        Some(AccountKey {
            pair,
            pkcs8: pkcs8.to_vec(),
        })
    }

    pub(super) fn pkcs8(&self) -> &[u8] {
        &self.pkcs8
    }

    /// The public key as a JWK, its members in the order RFC 7638's
    /// thumbprint hashes them.
    fn jwk(&self) -> Value {
        // An uncompressed point: 4, then x and y.
        let point = self.pair.public_key().as_ref();
        json!({
            "crv": "P-256",
            "kty": "EC",
            "x": base64url(&point[1..33]),
            "y": base64url(&point[33..65]),
        })
    }

    /// RFC 7638's thumbprint, which a key authorization ends with.
    fn thumbprint(&self) -> String {
        let jwk = self.jwk();
        // serde_json writes an object's members sorted, as RFC 7638 wants.
        base64url(&Sha256::digest(jwk.to_string().as_bytes()))
    }

    /// A JWS of `payload` for `url`, signed with this key and naming it by
    /// `kid`, or by its JWK before the account exists.
    fn signed(
        &self,
        url: &str,
        nonce: &str,
        kid: Option<&str>,
        payload: Option<&Value>,
    ) -> Vec<u8> {
        let mut protected = json!({"alg": "ES256", "nonce": nonce, "url": url});
        match kid {
            Some(kid) => protected["kid"] = json!(kid),
            None => protected["jwk"] = self.jwk(),
        }
        let protected = base64url(protected.to_string().as_bytes());
        // A POST-as-GET's payload is empty.
        let payload = payload.map_or_else(String::new, |payload| {
            base64url(payload.to_string().as_bytes())
        });
        let signature = self
            .pair
            .sign(
                &SystemRandom::new(),
                format!("{protected}.{payload}").as_bytes(),
            )
            .expect("signing works");
        json!({
            "protected": protected,
            "payload": payload,
            "signature": base64url(signature.as_ref()),
        })
        .to_string()
        .into_bytes()
    }
}

/// What the desk must answer `acme-tls/1` connections to `host` with, while
/// the authority checks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Challenge {
    pub host: String,
    /// The SHA-256 of the key authorization, which the challenge
    /// certificate's acmeIdentifier extension carries.
    pub digest: [u8; 32],
}

/// A certificate and its key, as PEM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Issued {
    pub chain_pem: String,
    pub key_pem: String,
}

/// How many times an order or authorization is checked before giving up.
const POLLS: usize = 30;

/// Gets a certificate for `host` from the authority whose directory is at
/// `directory`, as the account `key`. `challenged` is told the challenge to
/// answer while the authority checks, then `None`; `wait` pauses between
/// checks.
pub(super) fn issue(
    http: &mut dyn Http,
    directory: &str,
    key: &AccountKey,
    host: &str,
    challenged: &mut dyn FnMut(Option<Challenge>),
    wait: &mut dyn FnMut(),
) -> Result<Issued, String> {
    let directory = body(http.get(directory).map_err(|why| why.to_string())?)?;
    let endpoint = |name: &str| {
        directory[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("the directory has no {name}"))
    };
    let mut session = Session {
        http,
        key,
        kid: None,
        nonce: None,
        new_nonce: endpoint("newNonce")?,
    };
    let account = session.post(
        &endpoint("newAccount")?,
        Some(&json!({"termsOfServiceAgreed": true})),
    )?;
    session.kid = Some(account.location.ok_or("the authority named no account")?);
    let order = session.post(
        &endpoint("newOrder")?,
        Some(&json!({"identifiers": [{"type": "dns", "value": host}]})),
    )?;
    let order_url = order
        .location
        .clone()
        .ok_or("the authority named no order")?;
    let order = body(order)?;
    for authorization in order["authorizations"].as_array().into_iter().flatten() {
        let url = authorization
            .as_str()
            .ok_or("an authorization is not a URL")?;
        let proved = prove(&mut session, url, host, challenged, wait);
        challenged(None);
        proved?;
    }
    let (key_pem, csr) = request(host)?;
    let finalize = order["finalize"]
        .as_str()
        .ok_or("the order has no finalize")?;
    session.post(finalize, Some(&json!({"csr": base64url(&csr)})))?;
    let mut order = Value::Null;
    for _ in 0..POLLS {
        order = body(session.post(&order_url, None)?)?;
        match order["status"].as_str() {
            Some("valid") => break,
            Some("invalid") => return Err(format!("the order failed: {order}")),
            _ => wait(),
        }
    }
    let certificate = order["certificate"]
        .as_str()
        .ok_or_else(|| format!("the order never finished: {order}"))?;
    let chain = session.post(certificate, None)?;
    Ok(Issued {
        chain_pem: String::from_utf8(chain.body).map_err(|_| "the certificate is not PEM")?,
        key_pem,
    })
}

/// Answers one authorization's TLS-ALPN-01 challenge, until it is valid.
fn prove(
    session: &mut Session<'_>,
    url: &str,
    host: &str,
    challenged: &mut dyn FnMut(Option<Challenge>),
    wait: &mut dyn FnMut(),
) -> Result<(), String> {
    let authorization = body(session.post(url, None)?)?;
    if authorization["status"] == "valid" {
        return Ok(());
    }
    let challenge = authorization["challenges"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|challenge| challenge["type"] == "tls-alpn-01")
        .ok_or("the authority offers no tls-alpn-01 challenge")?;
    let token = challenge["token"]
        .as_str()
        .ok_or("the challenge has no token")?;
    let respond_at = challenge["url"]
        .as_str()
        .ok_or("the challenge has no URL")?;
    let key_authorization = format!("{token}.{}", session.key.thumbprint());
    challenged(Some(Challenge {
        host: host.to_string(),
        digest: Sha256::digest(key_authorization.as_bytes()).into(),
    }));
    session.post(respond_at, Some(&json!({})))?;
    for _ in 0..POLLS {
        wait();
        let authorization = body(session.post(url, None)?)?;
        match authorization["status"].as_str() {
            Some("valid") => return Ok(()),
            Some("pending" | "processing") => {}
            _ => {
                return Err(format!(
                    "the authority refused the challenge: {authorization}"
                ))
            }
        }
    }
    Err("the authority never checked the challenge".into())
}

/// A new key for `host`'s certificate, as PEM, and a CSR for it, as DER.
fn request(host: &str) -> Result<(String, Vec<u8>), String> {
    let key = rcgen::KeyPair::generate().map_err(|why| why.to_string())?;
    let mut params =
        rcgen::CertificateParams::new(vec![host.to_string()]).map_err(|why| why.to_string())?;
    // rcgen names a certificate "rcgen self signed cert" by default, which an
    // authority reads as one more name to certify and refuses.
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, host);
    let csr = params
        .serialize_request(&key)
        .map_err(|why| why.to_string())?;
    Ok((key.serialize_pem(), csr.der().to_vec()))
}

/// Signed requests to the authority, each with a fresh nonce.
struct Session<'a> {
    http: &'a mut dyn Http,
    key: &'a AccountKey,
    kid: Option<String>,
    nonce: Option<String>,
    new_nonce: String,
}

impl Session<'_> {
    /// POSTs `payload`, or a POST-as-GET without one. A nonce the authority
    /// calls stale is retried once with the fresh one it sent.
    fn post(&mut self, url: &str, payload: Option<&Value>) -> Result<Answer, String> {
        for _ in 0..2 {
            let nonce = match self.nonce.take() {
                Some(nonce) => nonce,
                None => self
                    .http
                    .head(&self.new_nonce)
                    .map_err(|why| why.to_string())?
                    .nonce
                    .ok_or("the authority gave no nonce")?,
            };
            let signed = self.key.signed(url, &nonce, self.kid.as_deref(), payload);
            let answer = self
                .http
                .post(url, &signed)
                .map_err(|why| why.to_string())?;
            self.nonce.clone_from(&answer.nonce);
            if answer.status < 400 {
                return Ok(answer);
            }
            let problem: Value = serde_json::from_slice(&answer.body).unwrap_or(Value::Null);
            if problem["type"] != "urn:ietf:params:acme:error:badNonce" {
                return Err(format!("{url} answered {}: {problem}", answer.status));
            }
        }
        Err(format!("{url} kept refusing the nonce"))
    }
}

fn body(answer: Answer) -> Result<Value, String> {
    serde_json::from_slice(&answer.body).map_err(|why| format!("the authority said no JSON: {why}"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};

    use super::*;

    const DIRECTORY: &str = "https://ca.example/directory";

    /// An authority that checks every signature and nonce, and checks the
    /// challenge against what the desk said it would answer.
    #[derive(Default)]
    struct Authority {
        nonces: u32,
        issued_nonce: Option<String>,
        /// Account URL to its JWK.
        accounts: HashMap<String, Value>,
        /// What the desk answers `acme-tls/1` with now.
        answering: Option<Challenge>,
        responded: bool,
        polls: u32,
        stale_once: bool,
        csr: Option<Vec<u8>>,
    }

    fn answer(status: u16, location: Option<&str>, body: Value) -> Answer {
        Answer {
            status,
            location: location.map(str::to_string),
            nonce: None,
            body: body.to_string().into_bytes(),
        }
    }

    fn unbase64url(text: &str) -> Vec<u8> {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut bits = 0u32;
        let mut count = 0;
        let mut out = Vec::new();
        for byte in text.bytes() {
            let value = ALPHABET.iter().position(|letter| *letter == byte).unwrap() as u32;
            bits = bits << 6 | value;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
            }
        }
        out
    }

    impl Authority {
        fn nonce(&mut self) -> String {
            self.nonces += 1;
            let nonce = format!("nonce-{}", self.nonces);
            self.issued_nonce = Some(nonce.clone());
            nonce
        }

        /// The payload of a JWS POSTed to `url`, after checking it.
        fn opened(&mut self, url: &str, body: &[u8]) -> (Option<Value>, Option<Value>) {
            let jws: Value = serde_json::from_slice(body).unwrap();
            let protected: Value =
                serde_json::from_slice(&unbase64url(jws["protected"].as_str().unwrap())).unwrap();
            assert_eq!(protected["alg"], "ES256");
            assert_eq!(protected["url"], url);
            assert_eq!(
                protected["nonce"].as_str(),
                self.issued_nonce.as_deref(),
                "a nonce is used once"
            );
            self.issued_nonce = None;
            let jwk = match protected["kid"].as_str() {
                Some(kid) => self.accounts[kid].clone(),
                None => protected["jwk"].clone(),
            };
            let mut point = vec![4];
            point.extend(unbase64url(jwk["x"].as_str().unwrap()));
            point.extend(unbase64url(jwk["y"].as_str().unwrap()));
            let input = format!(
                "{}.{}",
                jws["protected"].as_str().unwrap(),
                jws["payload"].as_str().unwrap()
            );
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
                .verify(
                    input.as_bytes(),
                    &unbase64url(jws["signature"].as_str().unwrap()),
                )
                .expect("the signature verifies");
            let payload = jws["payload"].as_str().unwrap();
            let payload = (!payload.is_empty())
                .then(|| serde_json::from_slice(&unbase64url(payload)).unwrap());
            (payload, Some(jwk))
        }
    }

    impl Http for Authority {
        fn head(&mut self, url: &str) -> io::Result<Answer> {
            assert_eq!(url, "https://ca.example/nonce");
            let mut answered = answer(200, None, Value::Null);
            answered.nonce = Some(self.nonce());
            Ok(answered)
        }

        fn get(&mut self, url: &str) -> io::Result<Answer> {
            assert_eq!(url, DIRECTORY);
            Ok(answer(
                200,
                None,
                json!({
                    "newNonce": "https://ca.example/nonce",
                    "newAccount": "https://ca.example/account",
                    "newOrder": "https://ca.example/order",
                }),
            ))
        }

        fn post(&mut self, url: &str, body: &[u8]) -> io::Result<Answer> {
            if self.stale_once {
                self.stale_once = false;
                let mut stale = answer(
                    400,
                    None,
                    json!({"type": "urn:ietf:params:acme:error:badNonce"}),
                );
                stale.nonce = Some(self.nonce());
                return Ok(stale);
            }
            let (payload, jwk) = self.opened(url, body);
            let mut answered = match url {
                "https://ca.example/account" => {
                    assert_eq!(payload.unwrap()["termsOfServiceAgreed"], true);
                    self.accounts
                        .insert("https://ca.example/acct/1".into(), jwk.unwrap());
                    answer(
                        201,
                        Some("https://ca.example/acct/1"),
                        json!({"status": "valid"}),
                    )
                }
                "https://ca.example/order" => {
                    assert_eq!(
                        payload.unwrap()["identifiers"],
                        json!([{"type": "dns", "value": "abc.relay.example"}])
                    );
                    answer(
                        201,
                        Some("https://ca.example/order/1"),
                        json!({
                            "status": "pending",
                            "authorizations": ["https://ca.example/authz/1"],
                            "finalize": "https://ca.example/finalize/1",
                        }),
                    )
                }
                "https://ca.example/authz/1" => {
                    let status = if self.responded {
                        self.polls += 1;
                        if self.polls > 1 {
                            "valid"
                        } else {
                            "pending"
                        }
                    } else {
                        "pending"
                    };
                    answer(
                        200,
                        None,
                        json!({
                            "status": status,
                            "challenges": [
                                {"type": "http-01", "url": "https://ca.example/chall/0", "token": "other"},
                                {"type": "tls-alpn-01", "url": "https://ca.example/chall/1", "token": "tok"},
                            ],
                        }),
                    )
                }
                "https://ca.example/chall/1" => {
                    // The desk answers with the key authorization's digest.
                    let thumbprint = base64url(&Sha256::digest(
                        self.accounts["https://ca.example/acct/1"]
                            .to_string()
                            .as_bytes(),
                    ));
                    let expected: [u8; 32] =
                        Sha256::digest(format!("tok.{thumbprint}").as_bytes()).into();
                    assert_eq!(
                        self.answering,
                        Some(Challenge {
                            host: "abc.relay.example".into(),
                            digest: expected
                        })
                    );
                    self.responded = true;
                    answer(200, None, json!({"status": "processing"}))
                }
                "https://ca.example/finalize/1" => {
                    self.csr = Some(unbase64url(payload.unwrap()["csr"].as_str().unwrap()));
                    answer(200, None, json!({"status": "processing"}))
                }
                "https://ca.example/order/1" => answer(
                    200,
                    None,
                    json!({"status": "valid", "certificate": "https://ca.example/cert/1"}),
                ),
                "https://ca.example/cert/1" => Answer {
                    status: 200,
                    location: None,
                    nonce: None,
                    body: b"-----BEGIN CERTIFICATE-----\nchain\n-----END CERTIFICATE-----\n"
                        .to_vec(),
                },
                other => panic!("POST to {other}"),
            };
            answered.nonce = Some(self.nonce());
            Ok(answered)
        }
    }

    /// Issues with `authority`, recording each challenge the desk is told.
    fn issued(authority: &mut Authority) -> (Result<Issued, String>, Vec<Option<Challenge>>) {
        let key = AccountKey::generate();
        let told = std::cell::RefCell::new(Vec::new());
        let answering = std::cell::RefCell::new(None);
        // The authority sees what the desk answers with as it is told.
        struct Watching<'a> {
            authority: &'a mut Authority,
            answering: &'a std::cell::RefCell<Option<Challenge>>,
        }
        impl Http for Watching<'_> {
            fn head(&mut self, url: &str) -> io::Result<Answer> {
                self.authority.head(url)
            }
            fn get(&mut self, url: &str) -> io::Result<Answer> {
                self.authority.get(url)
            }
            fn post(&mut self, url: &str, body: &[u8]) -> io::Result<Answer> {
                self.authority
                    .answering
                    .clone_from(&self.answering.borrow());
                self.authority.post(url, body)
            }
        }
        let mut http = Watching {
            authority,
            answering: &answering,
        };
        let result = issue(
            &mut http,
            DIRECTORY,
            &key,
            "abc.relay.example",
            &mut |challenge| {
                told.borrow_mut().push(challenge.clone());
                *answering.borrow_mut() = challenge;
            },
            &mut || {},
        );
        (result, told.into_inner())
    }

    #[test]
    fn a_certificate_is_issued_after_answering_tls_alpn() {
        let mut authority = Authority::default();
        let (issued, told) = issued(&mut authority);
        let issued = issued.unwrap();
        assert!(issued.chain_pem.contains("BEGIN CERTIFICATE"));
        assert!(issued.key_pem.contains("PRIVATE KEY"));
        let csr = authority.csr.unwrap();
        let has = |text: &[u8]| csr.windows(text.len()).any(|window| window == text);
        // Its only name is the host, as its subject and its one SAN; an
        // authority refuses any other.
        assert!(has(b"abc.relay.example"));
        assert!(!has(b"rcgen"), "rcgen's default subject is gone");
        assert_eq!(told.len(), 2);
        assert_eq!(told.last(), Some(&None), "the challenge is dropped after");
    }

    #[test]
    fn a_stale_nonce_is_retried_with_the_fresh_one() {
        let mut authority = Authority {
            stale_once: true,
            ..Authority::default()
        };
        assert!(issued(&mut authority).0.is_ok());
    }

    #[test]
    fn an_account_key_reads_back_from_pkcs8() {
        let key = AccountKey::generate();
        let again = AccountKey::from_pkcs8(key.pkcs8()).unwrap();
        assert_eq!(key.thumbprint(), again.thumbprint());
        assert!(AccountKey::from_pkcs8(b"not a key").is_none());
    }
}
