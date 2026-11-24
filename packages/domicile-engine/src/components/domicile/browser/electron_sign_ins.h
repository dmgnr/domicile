// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_SIGN_INS_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_SIGN_INS_H_

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <variant>

#include "base/functional/callback.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "url/gurl.h"

namespace domicile {

// What a page's connection asks an Electron app, as `login`,
// `certificate-error` and `select-client-certificate`:
//
//   -> {"type":"login","ask":1,"window":1,"session":"",
//       "url":"https://a.test/",
//       "auth_info":{"is_proxy":false,"scheme":"basic","host":"a.test",
//                    "port":443,"realm":"office"}}
//   {"type":"login_answer","ask":1,"action":"sign_in","username":"u",
//    "password":"p"}                       (or "action":"cancel", or
//                                           "default": no listener took it,
//                                           and the shell asks the user)
//   -> {"type":"certificate_error","ask":2,"window":1,"session":"",
//       "url":"https://a.test/","error":"net::ERR_CERT_AUTHORITY_INVALID",
//       "certificate":{...Electron's Certificate...},"is_main_frame":true}
//   {"type":"certificate_answer","ask":2,"allow":true}
//   -> {"type":"select_client_certificate","ask":3,"window":1,"session":"",
//       "url":"a.test:443","certificates":[{...},{...}]}
//   {"type":"client_certificate_answer","ask":3,"certificate":0}
//                                          (the index of the one chosen;
//                                           left out for none)
//
// "window" is left out when no window's page asked. Asks are numbered by the
// engine, per app, from 1.

// A sign-in a site or a proxy asks for.
struct ElectronLoginAsk {
  GURL url;
  bool is_proxy = false;
  // The scheme, lowercase: "basic", "digest", "ntlm", "negotiate".
  std::string scheme;
  std::string host;
  int port = 0;
  std::string realm;
};

enum class ElectronLoginAction { kSignIn, kCancel, kDefault };

struct ElectronLoginAnswer {
  ElectronLoginAction action = ElectronLoginAction::kCancel;
  // With kSignIn.
  std::u16string username;
  std::u16string password;

  friend bool operator==(const ElectronLoginAnswer&,
                         const ElectronLoginAnswer&) = default;
};

// A certificate the engine could not verify.
struct ElectronCertificateErrorAsk {
  GURL url;
  // net's name for the error, "net::ERR_CERT_AUTHORITY_INVALID".
  std::string error;
  // Electron's Certificate.
  base::DictValue certificate;
  bool is_main_frame = false;
};

// A client certificate a site asks for, from the ones the system has.
struct ElectronClientCertificateAsk {
  // The site's host and port, "a.test:443".
  std::string host_and_port;
  // Each an Electron Certificate, never none.
  base::ListValue certificates;
};

struct ElectronLoginReply {
  int ask = 0;
  ElectronLoginAnswer answer;

  friend bool operator==(const ElectronLoginReply&,
                         const ElectronLoginReply&) = default;
};
struct ElectronCertificateReply {
  int ask = 0;
  bool allow = false;

  friend bool operator==(const ElectronCertificateReply&,
                         const ElectronCertificateReply&) = default;
};
struct ElectronClientCertificateReply {
  int ask = 0;
  // An index into the certificates offered; none for none.
  std::optional<int> certificate;

  friend bool operator==(const ElectronClientCertificateReply&,
                         const ElectronClientCertificateReply&) = default;
};
using ElectronSignInReply = std::variant<ElectronLoginReply,
                                         ElectronCertificateReply,
                                         ElectronClientCertificateReply>;

// Whether a request of type `type` is one of the answers above.
bool IsElectronSignInReply(std::string_view type);
// The answer of type `type` in `request`, or why it is not one.
base::expected<ElectronSignInReply, std::string> ParseElectronSignInReply(
    std::string_view type,
    const base::DictValue& request);

// The lines that ask, for session `session`, by window `window`'s page when
// one asked.
std::string ElectronLoginAsked(int ask,
                               std::optional<int> window,
                               std::string_view session,
                               const ElectronLoginAsk& login);
std::string ElectronCertificateErrorAsked(
    int ask,
    std::optional<int> window,
    std::string_view session,
    const ElectronCertificateErrorAsk& error);
std::string ElectronClientCertificateAsked(
    int ask,
    std::optional<int> window,
    std::string_view session,
    const ElectronClientCertificateAsk& select);

// The questions waiting on an app's answers, by ask. Each is answered once:
// by the app, or as it goes, when its sign-in is canceled, its certificate
// refused and no client certificate chosen.
class ElectronSignInAsks {
 public:
  using LoginAnswered = base::OnceCallback<void(ElectronLoginAnswer)>;
  using CertificateAnswered = base::OnceCallback<void(bool allow)>;
  using ClientCertificateAnswered =
      base::OnceCallback<void(std::optional<int> certificate)>;

  ElectronSignInAsks();
  ElectronSignInAsks(const ElectronSignInAsks&) = delete;
  ElectronSignInAsks& operator=(const ElectronSignInAsks&) = delete;
  ~ElectronSignInAsks();

  // Each gives the new ask's number.
  int Add(LoginAnswered answered);
  int Add(CertificateAnswered answered);
  // Of `offered` certificates.
  int Add(ClientCertificateAnswered answered, int offered);

  // Answers the ask `reply` names, or says why it can't: nothing waits for
  // it, it waits for another kind of answer, or it names a certificate never
  // offered. A client certificate ask refused for that goes on without one.
  std::optional<std::string> Answer(const ElectronSignInReply& reply);

 private:
  struct ClientCertificate {
    ClientCertificateAnswered answered;
    int offered = 0;
  };
  using Waiting =
      std::variant<LoginAnswered, CertificateAnswered, ClientCertificate>;
  std::map<int, Waiting> waiting_;
  int next_ = 1;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_SIGN_INS_H_
