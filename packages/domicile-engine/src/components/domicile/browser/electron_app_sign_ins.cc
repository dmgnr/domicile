// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

// ElectronApp and ElectronSession's sign-in and certificate questions, and
// their sessions' service worker watches. See electron_sign_ins.h and
// electron_network_calls.h.

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/electron_network_calls.h"
#include "components/domicile/browser/electron_protocol.h"
#include "components/domicile/browser/electron_sign_ins.h"
#include "components/domicile/browser/web_view_partition.h"

namespace domicile {

void ElectronSession::AskToSignIn(const std::optional<std::string>& window,
                                  const ElectronLoginAsk& login,
                                  ElectronSignInAsks::LoginAnswered answered) {
  const int ask = app_->sign_ins_.Add(std::move(answered));
  app_->send_.Run(ElectronLoginAsked(
      ask, window.has_value() ? app_->NumberOf(*window) : std::nullopt, name_,
      login));
}

void ElectronSession::AskAboutCertificateError(
    const std::string& window,
    const ElectronCertificateErrorAsk& error,
    ElectronSignInAsks::CertificateAnswered answered) {
  const int ask = app_->sign_ins_.Add(std::move(answered));
  app_->send_.Run(
      ElectronCertificateErrorAsked(ask, app_->NumberOf(window), name_, error));
}

void ElectronSession::AskForClientCertificate(
    const std::optional<std::string>& window,
    const ElectronClientCertificateAsk& select,
    ElectronSignInAsks::ClientCertificateAnswered answered) {
  const int ask = app_->sign_ins_.Add(
      std::move(answered), static_cast<int>(select.certificates.size()));
  app_->send_.Run(ElectronClientCertificateAsked(
      ask, window.has_value() ? app_->NumberOf(*window) : std::nullopt, name_,
      select));
}

void ElectronApp::AnswerSignIn(const ElectronSignInReply& reply) {
  if (const std::optional<std::string> why = sign_ins_.Answer(reply)) {
    send_.Run(ElectronRefused(*why));
  }
}

void ElectronApp::WatchServiceWorkers(
    const std::string& session,
    const WebViewPartition& partition,
    base::OnceCallback<void(base::expected<base::Value, std::string>)> done) {
  auto watching = service_worker_watches_.find(session);
  if (watching == service_worker_watches_.end()) {
    watching =
        service_worker_watches_
            .emplace(session,
                     desk_->WatchServiceWorkers(
                         partition, base::BindRepeating(
                                        &ElectronApp::ServiceWorkerChanged,
                                        weak_factory_.GetWeakPtr(), session)))
            .first;
  }
  std::move(done).Run(
      ElectronRunningServiceWorkersValue(watching->second->Running()));
}

void ElectronApp::ServiceWorkerChanged(
    const std::string& session,
    const ElectronServiceWorkerChange& change) {
  send_.Run(ElectronServiceWorkerChanged(session, change));
}

}  // namespace domicile
