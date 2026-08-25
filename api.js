/**
 * EcoCash Sandbox API Client  v2.0
 * ─────────────────────────────────
 * Base URL : https://developers.ecocash.co.zw/api/sandbox
 * Auth     : HTTP Basic  →  Base64(username:password)
 *
 * Sandbox credentials
 *   Username        sbx_ae9c682bcdfd
 *   Password        GGNCosyRpwTPM#vkS@ir
 *   Merchant Code   287164
 *   Merchant PIN    1234
 *   Merchant Number 778503033
 *
 * ⚠  Rotate password before going to production.
 */

const EcoCashAPI = (() => {

  /* ─────────────────────── Config ─────────────────────── */
  const CFG = {
    base:           'https://developers.ecocash.co.zw/api/sandbox',
    username:       'sbx_ae9c682bcdfd',
    password:       'GGNCosyRpwTPM#vkS@ir',
    merchantCode:   '287164',
    merchantPin:    '1234',
    merchantNumber: '778503033',
    notifyUrl:      'https://example.com/notify',   // replace with real webhook
  };

  /* ─────────────────────── Auth ───────────────────────── */
  const basicAuth = () => 'Basic ' + btoa(CFG.username + ':' + CFG.password);

  /* ─────────────────────── Correlator ─────────────────── */
  function newCorrelator() {
    return 'ECX-' + Date.now().toString(36).toUpperCase()
         + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  /* ─────────────────────── MSISDN helper ──────────────── */
  // Normalise to 263XXXXXXXXX (12 digits, no leading +)
  function toMSISDN(raw) {
    let v = String(raw).replace(/\D/g, '');
    if (v.startsWith('00263')) v = v.slice(5);
    else if (v.startsWith('263') && v.length === 12) v = v.slice(3);
    else if (v.startsWith('0'))  v = v.slice(1);
    // v is now 9 digits starting with 7X
    return '263' + v;
  }

  /* ─────────────────────── HTTP ───────────────────────── */
  async function post(path, body) {
    let res, data;
    try {
      res = await fetch(CFG.base + path, {
        method:  'POST',
        headers: {
          'Authorization': basicAuth(),
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        },
        body: JSON.stringify(body),
      });
      // Some endpoints return empty body on success
      const text = await res.text();
      data = text ? JSON.parse(text) : {};
    } catch (netErr) {
      throw new EcoError('network', 'Network error — check your connection.');
    }

    if (!res.ok) {
      const msg = data?.message || data?.description || data?.error
                  || `Server returned ${res.status}`;
      throw new EcoError(res.status, msg, data);
    }
    return data;
  }

  /* ─────────────────────── Error type ─────────────────── */
  function EcoError(code, message, raw) {
    this.code    = code;
    this.message = message;
    this.raw     = raw || null;
  }
  EcoError.prototype = Object.create(Error.prototype);

  /* ═══════════════════════════════════════════════════════
     PUBLIC API METHODS
     Each method tries the real endpoint.
     On sandbox-specific failures (404 / 501 / "not supported")
     it resolves with a { _sandboxFallback: true } marker
     so callers can decide whether to continue.
     ═══════════════════════════════════════════════════════ */

  /**
   * validateSubscriber(msisdn)
   * Confirm the number is a registered Econet account.
   * POST /subscribers/validate
   */
  async function validateSubscriber(msisdn) {
    try {
      return await post('/subscribers/validate', {
        msisdn:       toMSISDN(msisdn),
        merchantCode: CFG.merchantCode,
      });
    } catch (err) {
      // Sandbox may not expose this endpoint — treat Econet prefixes as valid
      if (_isSandboxGap(err)) return { _sandboxFallback: true };
      throw err;
    }
  }

  /**
   * chargeSubscriber({ msisdn, amount, narrative, pin })
   * Initiate C2B payment.  Returns API response; also saves
   * correlator + txn snapshot to sessionStorage automatically.
   * POST /transactions/charges
   */
  async function chargeSubscriber({ msisdn, amount, narrative, pin }) {
    const correlator = newCorrelator();
    sessionStorage.setItem('ecoCorrelator', correlator);

    const body = {
      clientCorrelator:     correlator,
      notifyUrl:            CFG.notifyUrl,
      referenceCode:        correlator,
      tranType:             'MER',
      endUserId:            toMSISDN(msisdn),
      merchantCode:         CFG.merchantCode,
      merchantPin:          pin || CFG.merchantPin,
      merchantNumber:       CFG.merchantNumber,
      currency:             'USD',
      amount:               parseFloat(amount).toFixed(2),
      remarks:              narrative || 'EcoCash Mix Bundle',
      purchaseCategoryCode: '002',
    };

    let result;
    try {
      result = await post('/transactions/charges', body);
    } catch (err) {
      if (_isSandboxGap(err)) {
        result = { _sandboxFallback: true, clientCorrelator: correlator };
      } else {
        throw err;
      }
    }

    // Persist transaction snapshot for thankyou page
    sessionStorage.setItem('ecoTxn', JSON.stringify({
      correlator,
      status:    result.transactionOperationStatus || 'pending',
      amount:    parseFloat(amount).toFixed(2),
      timestamp: new Date().toISOString(),
    }));

    return result;
  }

  /**
   * queryTransaction(correlator)
   * Poll for final status.
   * POST /transactions/query
   */
  async function queryTransaction(correlator) {
    try {
      return await post('/transactions/query', {
        clientCorrelator: correlator,
        merchantCode:     CFG.merchantCode,
      });
    } catch (err) {
      if (_isSandboxGap(err)) return { _sandboxFallback: true };
      throw err;
    }
  }

  /**
   * generateOTP(msisdn)
   * Trigger SMS OTP to subscriber.
   * POST /otp/generate
   */
  async function generateOTP(msisdn) {
    try {
      return await post('/otp/generate', {
        msisdn:       toMSISDN(msisdn),
        merchantCode: CFG.merchantCode,
      });
    } catch (err) {
      if (_isSandboxGap(err)) return { _sandboxFallback: true };
      throw err;
    }
  }

  /**
   * verifyOTP(msisdn, otpCode)
   * Confirm OTP entered by user.
   * POST /otp/verify
   */
  async function verifyOTP(msisdn, otpCode) {
    try {
      return await post('/otp/verify', {
        msisdn:       toMSISDN(msisdn),
        otp:          String(otpCode),
        merchantCode: CFG.merchantCode,
      });
    } catch (err) {
      if (_isSandboxGap(err)) return { _sandboxFallback: true };
      throw err;
    }
  }

  /* ─────────────────────── Sandbox gap detector ───────── */
  // Returns true when the sandbox simply doesn't implement the endpoint
  // (vs. a real auth/validation error we should surface to the user).
  function _isSandboxGap(err) {
    const code = err.code;
    if (code === 'network') return true;          // CORS / no server
    if (code === 404 || code === 501) return true; // endpoint not implemented
    const msg = (err.message || '').toLowerCase();
    return msg.includes('not found')
        || msg.includes('not supported')
        || msg.includes('not implemented')
        || msg.includes('unavailable');
  }

  /* ─────────────────────── Exports ────────────────────── */
  return {
    validateSubscriber,
    chargeSubscriber,
    queryTransaction,
    generateOTP,
    verifyOTP,
    toMSISDN,
    CFG,
    EcoError,
  };

})();
