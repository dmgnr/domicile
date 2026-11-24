// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_electron_certificates.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "chrome/browser/domicile/domicile_electron_page.h"
#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/electron_sign_ins.h"
#include "components/domicile/browser/web_view_guest.h"
#include "content/public/browser/client_certificate_delegate.h"
#include "content/public/browser/web_contents.h"
#include "net/base/hash_value.h"
#include "net/base/net_errors.h"
#include "net/cert/x509_cert_types.h"
#include "net/cert/x509_certificate.h"
#include "net/ssl/ssl_cert_request_info.h"
#include "net/ssl/ssl_info.h"
#include "net/ssl/ssl_private_key.h"
#include "third_party/boringssl/src/include/openssl/pool.h"
#include "url/gurl.h"

namespace domicile {
namespace {

base::ListValue Strings(const std::vector<std::string>& strings) {
  base::ListValue list;
  for (const std::string& each : strings) {
    list.Append(each);
  }
  return list;
}

base::DictValue PrincipalOf(const net::CertPrincipal& principal) {
  return base::DictValue()
      .Set("commonName", principal.common_name)
      .Set("organizations", Strings(principal.organization_names))
      .Set("organizationUnits", Strings(principal.organization_unit_names))
      .Set("locality", principal.locality_name)
      .Set("state", principal.state_or_province_name)
      .Set("country", principal.country_name);
}

// The page's app's session and its window, when `contents` is an Electron
// app's page.
struct ElectronPageOf {
  base::WeakPtr<ElectronSession> session;
  std::string window;
};

std::optional<ElectronPageOf> PageOf(content::WebContents* contents) {
  if (contents == nullptr) {
    return std::nullopt;
  }
  base::WeakPtr<ElectronSession> session = ElectronPage::SessionOf(*contents);
  const WebViewGuest* guest = WebViewGuest::FromWebContents(contents);
  if (!session || guest == nullptr) {
    return std::nullopt;
  }
  return ElectronPageOf{.session = std::move(session),
                        .window = guest->window_id()};
}

}  // namespace

base::DictValue ElectronCertificateOf(const net::X509Certificate& certificate) {
  std::string pem;
  // A certificate net parsed has DER to encode: a failure is a bug.
  CHECK(net::X509Certificate::GetPEMEncoded(certificate.cert_buffer(), &pem));
  base::DictValue value;
  value.Set("data", std::move(pem));
  value.Set("issuer", PrincipalOf(certificate.issuer()));
  value.Set("issuerName", certificate.issuer().common_name);
  value.Set("subject", PrincipalOf(certificate.subject()));
  value.Set("subjectName", certificate.subject().common_name);
  value.Set("serialNumber", base::HexEncode(certificate.serial_number()));
  value.Set("validStart", certificate.valid_start().InSecondsFSinceUnixEpoch());
  value.Set("validExpiry",
            certificate.valid_expiry().InSecondsFSinceUnixEpoch());
  value.Set("fingerprint",
            net::HashValue(net::HASH_VALUE_SHA256,
                           net::X509Certificate::CalculateFingerprint256(
                               certificate.cert_buffer()))
                .ToString());
  // The issuer is the chain's next certificate, as Electron gives it.
  const auto intermediates = certificate.intermediate_buffers();
  if (!intermediates.empty()) {
    std::vector<bssl::UniquePtr<CRYPTO_BUFFER>> rest;
    for (const bssl::UniquePtr<CRYPTO_BUFFER>& each :
         intermediates.subspan(1u)) {
      rest.push_back(bssl::UpRef(each.get()));
    }
    scoped_refptr<net::X509Certificate> issuer =
        net::X509Certificate::CreateFromBuffer(
            bssl::UpRef(intermediates.front().get()), std::move(rest));
    // An intermediate net could not parse is left out, as Electron does.
    if (issuer) {
      value.Set("issuerCert", ElectronCertificateOf(*issuer));
    }
  }
  return value;
}

bool AskElectronAboutCertificateError(
    content::WebContents* contents,
    int cert_error,
    const net::SSLInfo& ssl_info,
    const GURL& request_url,
    bool is_primary_main_frame_request,
    base::OnceCallback<void(content::CertificateRequestResultType)>& callback) {
  std::optional<ElectronPageOf> page = PageOf(contents);
  if (!page.has_value()) {
    return false;
  }
  ElectronCertificateErrorAsk ask{
      .url = request_url,
      .error = net::ErrorToString(cert_error),
      .is_main_frame = is_primary_main_frame_request};
  if (ssl_info.cert) {
    ask.certificate = ElectronCertificateOf(*ssl_info.cert);
  }
  page->session->AskAboutCertificateError(
      page->window, ask,
      base::BindOnce(
          [](base::OnceCallback<void(content::CertificateRequestResultType)>
                 callback,
             bool allow) {
            // Chrome's own callers may pass none.
            if (callback.is_null()) {
              return;
            }
            std::move(callback).Run(
                allow ? content::CERTIFICATE_REQUEST_RESULT_TYPE_CONTINUE
                      : content::CERTIFICATE_REQUEST_RESULT_TYPE_DENY);
          },
          std::move(callback)));
  return true;
}

bool AskElectronForClientCertificate(
    content::WebContents* contents,
    const net::SSLCertRequestInfo& request,
    net::ClientCertIdentityList& certificates,
    std::unique_ptr<content::ClientCertificateDelegate>& delegate) {
  std::optional<ElectronPageOf> page = PageOf(contents);
  if (!page.has_value()) {
    return false;
  }
  if (certificates.empty()) {
    delegate->ContinueWithCertificate(nullptr, nullptr);
    delegate.reset();
    return true;
  }
  ElectronClientCertificateAsk ask{.host_and_port =
                                       request.host_and_port.ToString()};
  for (const std::unique_ptr<net::ClientCertIdentity>& identity :
       certificates) {
    ask.certificates.Append(ElectronCertificateOf(*identity->certificate()));
  }
  page->session->AskForClientCertificate(
      page->window, ask,
      base::BindOnce(
          [](net::ClientCertIdentityList certificates,
             std::unique_ptr<content::ClientCertificateDelegate> delegate,
             std::optional<int> chosen) {
            if (!chosen.has_value()) {
              delegate->ContinueWithCertificate(nullptr, nullptr);
              return;
            }
            // ElectronSignInAsks refuses an index never offered.
            std::unique_ptr<net::ClientCertIdentity> identity =
                std::move(certificates.at(static_cast<size_t>(*chosen)));
            scoped_refptr<net::X509Certificate> certificate =
                identity->certificate();
            net::ClientCertIdentity::SelfOwningAcquirePrivateKey(
                std::move(identity),
                base::BindOnce(
                    [](std::unique_ptr<content::ClientCertificateDelegate>
                           delegate,
                       scoped_refptr<net::X509Certificate> certificate,
                       scoped_refptr<net::SSLPrivateKey> key) {
                      // A certificate whose key can't be had goes on with
                      // none, as Chrome's own chooser does.
                      delegate->ContinueWithCertificate(
                          key ? std::move(certificate) : nullptr,
                          std::move(key));
                    },
                    std::move(delegate), std::move(certificate)));
          },
          std::move(certificates), std::move(delegate)));
  return true;
}

}  // namespace domicile
