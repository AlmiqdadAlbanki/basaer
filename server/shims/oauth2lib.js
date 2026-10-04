'use strict';

// Shim for the Apps Script OAuth2 library (used only by FCMService.js for a
// service-account JWT-bearer token). Chainable setters, hasAccess(),
// getAccessToken(). In dry-run mode a placeholder token is returned — the FCM
// call itself is dry-run too. In live mode a real JWT-bearer exchange is
// performed through the (live) UrlFetchApp.

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeOAuth2(getUrlFetchApp, mode) {
  function createService(serviceName) {
    const service = {
      _name: serviceName,
      _tokenUrl: 'https://oauth2.googleapis.com/token',
      _privateKey: null,
      _issuer: null,
      _scope: '',
      _propertyStore: null,
      _accessToken: null,
      _expiresAt: 0,
      _lastError: '',
      setTokenUrl(url) { service._tokenUrl = url; return service; },
      setPrivateKey(privateKeyPem) { service._privateKey = privateKeyPem; return service; },
      setIssuer(issuerEmail) { service._issuer = issuerEmail; return service; },
      setSubject() { return service; },
      setScope(scope) { service._scope = scope; return service; },
      setPropertyStore(store) { service._propertyStore = store; return service; },
      setCache() { return service; }, setLock() { return service; }, setParam() { return service; },
      setAuthorizationBaseUrl() { return service; }, setClientId() { return service; }, setClientSecret() { return service; },
      setCallbackFunction() { return service; }, setGrantType() { return service; },
      reset() { service._accessToken = null; service._expiresAt = 0; return service; },
      getLastError() { return service._lastError; },
      hasAccess() {
        if (mode !== 'live') return true;
        try { service.getAccessToken(); return !!service._accessToken; }
        catch (err) { service._lastError = String(err.message || err); return false; }
      },
      getAccessToken() {
        if (mode !== 'live') return 'dry-run-oauth2-token';
        if (service._accessToken && Date.now() < service._expiresAt - 60000) return service._accessToken;
        if (!service._privateKey || !service._issuer) throw new Error('OAuth2: private key / issuer not configured');
        const nowSeconds = Math.floor(Date.now() / 1000);
        const encodedHeader = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const encodedClaims = b64url(JSON.stringify({
          iss: service._issuer, scope: service._scope, aud: service._tokenUrl, iat: nowSeconds, exp: nowSeconds + 3600,
        }));
        const signature = crypto.createSign('RSA-SHA256')
          .update(encodedHeader + '.' + encodedClaims)
          .sign(service._privateKey.replace(/\\n/g, '\n'));
        const assertionJwt = encodedHeader + '.' + encodedClaims + '.' + b64url(signature);
        const response = getUrlFetchApp().fetch(service._tokenUrl, {
          method: 'post', contentType: 'application/x-www-form-urlencoded',
          payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertionJwt },
          muteHttpExceptions: true,
        });
        const tokenResponse = JSON.parse(response.getContentText());
        if (!tokenResponse.access_token) throw new Error(tokenResponse.error_description || tokenResponse.error || 'token exchange failed');
        service._accessToken = tokenResponse.access_token;
        service._expiresAt = Date.now() + (tokenResponse.expires_in || 3600) * 1000;
        return service._accessToken;
      },
    };
    return service;
  }
  return { createService };
}

module.exports = { makeOAuth2 };
