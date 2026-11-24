// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_CERTIFICATES_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_CERTIFICATES_H_

#include <memory>

#include "base/functional/callback.h"
#include "base/values.h"
#include "content/public/browser/certificate_request_result_type.h"
#include "net/ssl/client_cert_identity.h"

class GURL;

namespace content {
class ClientCertificateDelegate;
class WebContents;
}  // namespace content

namespace net {
class SSLCertRequestInfo;
class SSLInfo;
class X509Certificate;
}  // namespace net

namespace domicile {

// An Electron app's answers about its pages' certificates, as its
// `certificate-error` and `select-client-certificate` listeners give them
// (see components/domicile/browser/electron_sign_ins.h). Called first by
// ChromeContentBrowserClient's AllowCertificateError and
// SelectClientCertificate (patch 0268); a page that is no Electron app's
// goes on to Chrome, as before.

// `certificate` as Electron's Certificate, with its issuer's as
// "issuerCert" when the chain has it.
base::DictValue ElectronCertificateOf(const net::X509Certificate& certificate);

// Whether `contents` is an Electron app's page, whose app was asked: then
// `callback` is taken, and run with the app's answer, or with a refusal
// when the app goes first. Every frame's error is asked, as in Electron.
bool AskElectronAboutCertificateError(
    content::WebContents* contents,
    int cert_error,
    const net::SSLInfo& ssl_info,
    const GURL& request_url,
    bool is_primary_main_frame_request,
    base::OnceCallback<void(content::CertificateRequestResultType)>& callback);

// Whether `contents` is an Electron app's page, whose app chooses: then
// `certificates` and `delegate` are taken, and the request goes on with the
// one the app chose, or with none. With none to offer it goes on with none
// at once, as in Electron.
bool AskElectronForClientCertificate(
    content::WebContents* contents,
    const net::SSLCertRequestInfo& request,
    net::ClientCertIdentityList& certificates,
    std::unique_ptr<content::ClientCertificateDelegate>& delegate);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_CERTIFICATES_H_
