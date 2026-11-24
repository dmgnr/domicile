// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_sign_ins.h"

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include "base/check.h"
#include "base/json/json_writer.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/types/expected.h"
#include "base/values.h"

namespace domicile {
namespace {

std::string Line(base::DictValue event) {
  std::string line;
  // Asks hold strings, numbers and what the engine built: a write failure is
  // a bug.
  CHECK(base::JSONWriter::Write(event, &line));
  line.push_back('\n');
  return line;
}

base::DictValue Asked(std::string_view type,
                      int ask,
                      std::optional<int> window,
                      std::string_view session) {
  base::DictValue line;
  line.Set("type", type);
  line.Set("ask", ask);
  if (window.has_value()) {
    line.Set("window", *window);
  }
  line.Set("session", session);
  return line;
}

base::expected<ElectronLoginAnswer, std::string> LoginAnswerIn(
    const base::DictValue& request) {
  const std::string* action = request.FindString("action");
  if (action == nullptr) {
    return base::unexpected(
        "\"action\" must be \"sign_in\", \"cancel\" or \"default\"");
  } else if (*action == "cancel") {
    return ElectronLoginAnswer{.action = ElectronLoginAction::kCancel};
  } else if (*action == "default") {
    return ElectronLoginAnswer{.action = ElectronLoginAction::kDefault};
  } else if (*action != "sign_in") {
    return base::unexpected(
        "\"action\" must be \"sign_in\", \"cancel\" or \"default\"");
  }
  const std::string* username = request.FindString("username");
  const std::string* password = request.FindString("password");
  if (username == nullptr || password == nullptr) {
    return base::unexpected(
        "a sign-in's \"username\" and \"password\" must be strings");
  }
  return ElectronLoginAnswer{.action = ElectronLoginAction::kSignIn,
                             .username = base::UTF8ToUTF16(*username),
                             .password = base::UTF8ToUTF16(*password)};
}

}  // namespace

bool IsElectronSignInReply(std::string_view type) {
  return type == "login_answer" || type == "certificate_answer" ||
         type == "client_certificate_answer";
}

base::expected<ElectronSignInReply, std::string> ParseElectronSignInReply(
    std::string_view type,
    const base::DictValue& request) {
  const std::optional<int> ask = request.FindInt("ask");
  if (!ask.has_value() || *ask < 1) {
    return base::unexpected("\"ask\" must be a whole number from 1");
  } else if (type == "login_answer") {
    return LoginAnswerIn(request).transform(
        [&](ElectronLoginAnswer answer) -> ElectronSignInReply {
          return ElectronLoginReply{.ask = *ask, .answer = std::move(answer)};
        });
  } else if (type == "certificate_answer") {
    const std::optional<bool> allow = request.FindBool("allow");
    if (!allow.has_value()) {
      return base::unexpected("\"allow\" must be true or false");
    }
    return ElectronCertificateReply{.ask = *ask, .allow = *allow};
  }
  CHECK_EQ(type, "client_certificate_answer");
  const base::Value* certificate = request.Find("certificate");
  if (certificate == nullptr) {
    return ElectronClientCertificateReply{.ask = *ask};
  } else if (!certificate->is_int() || certificate->GetInt() < 0) {
    return base::unexpected(
        "\"certificate\" must be the index of one the engine offered");
  }
  return ElectronClientCertificateReply{.ask = *ask,
                                        .certificate = certificate->GetInt()};
}

std::string ElectronLoginAsked(int ask,
                               std::optional<int> window,
                               std::string_view session,
                               const ElectronLoginAsk& login) {
  base::DictValue line = Asked("login", ask, window, session);
  line.Set("url", login.url.spec());
  line.Set("auth_info", base::DictValue()
                            .Set("is_proxy", login.is_proxy)
                            .Set("scheme", login.scheme)
                            .Set("host", login.host)
                            .Set("port", login.port)
                            .Set("realm", login.realm));
  return Line(std::move(line));
}

std::string ElectronCertificateErrorAsked(
    int ask,
    std::optional<int> window,
    std::string_view session,
    const ElectronCertificateErrorAsk& error) {
  base::DictValue line = Asked("certificate_error", ask, window, session);
  line.Set("url", error.url.spec());
  line.Set("error", error.error);
  line.Set("certificate", error.certificate.Clone());
  line.Set("is_main_frame", error.is_main_frame);
  return Line(std::move(line));
}

std::string ElectronClientCertificateAsked(
    int ask,
    std::optional<int> window,
    std::string_view session,
    const ElectronClientCertificateAsk& select) {
  base::DictValue line =
      Asked("select_client_certificate", ask, window, session);
  line.Set("url", select.host_and_port);
  line.Set("certificates", select.certificates.Clone());
  return Line(std::move(line));
}

ElectronSignInAsks::ElectronSignInAsks() = default;

ElectronSignInAsks::~ElectronSignInAsks() {
  for (auto& entry : std::exchange(waiting_, {})) {
    Waiting& waiting = entry.second;
    if (auto* login = std::get_if<LoginAnswered>(&waiting)) {
      std::move(*login).Run(
          ElectronLoginAnswer{.action = ElectronLoginAction::kCancel});
    } else if (auto* certificate = std::get_if<CertificateAnswered>(&waiting)) {
      std::move(*certificate).Run(false);
    } else {
      std::move(std::get<ClientCertificate>(waiting).answered)
          .Run(std::nullopt);
    }
  }
}

int ElectronSignInAsks::Add(LoginAnswered answered) {
  waiting_.emplace(next_, std::move(answered));
  return next_++;
}

int ElectronSignInAsks::Add(CertificateAnswered answered) {
  waiting_.emplace(next_, std::move(answered));
  return next_++;
}

int ElectronSignInAsks::Add(ClientCertificateAnswered answered, int offered) {
  waiting_.emplace(next_, ClientCertificate{.answered = std::move(answered),
                                            .offered = offered});
  return next_++;
}

std::optional<std::string> ElectronSignInAsks::Answer(
    const ElectronSignInReply& reply) {
  const int ask = std::visit([](const auto& each) { return each.ask; }, reply);
  auto found = waiting_.find(ask);
  if (found == waiting_.end()) {
    return base::StrCat(
        {"no sign-in or certificate question is waiting for "
         "answer ",
         base::NumberToString(ask)});
  }
  Waiting waiting = std::move(found->second);
  if (auto* login = std::get_if<ElectronLoginReply>(&reply);
      login != nullptr && std::holds_alternative<LoginAnswered>(waiting)) {
    waiting_.erase(found);
    std::move(std::get<LoginAnswered>(waiting)).Run(login->answer);
    return std::nullopt;
  } else if (auto* certificate = std::get_if<ElectronCertificateReply>(&reply);
             certificate != nullptr &&
             std::holds_alternative<CertificateAnswered>(waiting)) {
    waiting_.erase(found);
    std::move(std::get<CertificateAnswered>(waiting)).Run(certificate->allow);
    return std::nullopt;
  } else if (auto* client = std::get_if<ElectronClientCertificateReply>(&reply);
             client != nullptr &&
             std::holds_alternative<ClientCertificate>(waiting)) {
    waiting_.erase(found);
    ClientCertificate& chosen = std::get<ClientCertificate>(waiting);
    if (client->certificate.has_value() &&
        *client->certificate >= chosen.offered) {
      std::move(chosen.answered).Run(std::nullopt);
      return base::StrCat({"answer ", base::NumberToString(ask),
                           " chose certificate ",
                           base::NumberToString(*client->certificate), " of ",
                           base::NumberToString(chosen.offered), " offered"});
    }
    std::move(chosen.answered).Run(client->certificate);
    return std::nullopt;
  }
  // Put back: the question still waits for its own kind of answer.
  found->second = std::move(waiting);
  return base::StrCat({"answer ", base::NumberToString(ask),
                       " is for another kind of question"});
}

}  // namespace domicile
