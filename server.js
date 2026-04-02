import 'dotenv/config';
import express from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const SITE_NAME = process.env.SITE_NAME || 'EbookStore';
const TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME || '';

app.use(express.json());

// Landing page (dinâmica com SITE_NAME)
app.get('/', (req, res) => {
  try {
    const html = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const rendered = html
      .replace(/\{\{SITE_NAME\}\}/g, SITE_NAME)
      .replace(/\{\{TELEGRAM_USERNAME\}\}/g, TELEGRAM_USERNAME);
    res.type('html').send(rendered);
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Arquivos estáticos (CSS, imagens, etc.)
app.use(express.static(path.join(__dirname, 'public')));

const escapeForJs = (s) =>
  String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\r/g, '')
    .replace(/\n/g, '');

const escapeHtml = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const applyCommonHeaders = (res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
};

async function handlePayJSRCheckout(req, res) {
  const { amount, currency = 'USD', success_url, cancel_url, product_name } = req.query;
  if (!amount || !success_url || !cancel_url) {
    return res.status(400).send('Missing required parameters');
  }

  const payjsrSecretKey = process.env.PAYJSR_SECRET_KEY;
  if (!payjsrSecretKey) {
    return res.status(500).send('PayJSR secret key not configured. Set PAYJSR_SECRET_KEY in Render.');
  }

  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return res.status(400).send('Invalid amount');
  }

  const amountCents = Math.round(amountNumber * 100);
  if (amountCents < 100) {
    return res.status(400).send('Amount too small (minimum is $1.00)');
  }

  applyCommonHeaders(res);

  const displayName = product_name || 'Digital Ebook';
  const origin = `${req.protocol}://${req.get('host')}`;
  const forwardSuccess = String(success_url);
  const successIntermediate = `${origin}/api/payjsr-success?forward=${encodeURIComponent(forwardSuccess)}`;

  const payload = {
    amount: amountCents,
    currency: String(currency || 'USD').toUpperCase(),
    description: displayName,
    billing_type: 'one_time',
    mode: 'redirect',
    success_url: successIntermediate,
    cancel_url: String(cancel_url),
    metadata: { product_name: String(displayName) },
  };

  const createRes = await fetch('https://api.payjsr.com/v1/api-create-payment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': payjsrSecretKey,
    },
    body: JSON.stringify(payload),
  });

  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    return res
      .status(createRes.status)
      .send(`Checkout failed (PayJSR): ${createData?.error || createData?.message || 'unknown error'}`);
  }

  const paymentId = createData?.data?.payment_id || createData?.data?.paymentId || createData?.payment_id;
  if (!paymentId) {
    return res.status(502).send('Checkout failed (PayJSR): missing payment_id');
  }

  const safePaymentId = escapeForJs(paymentId);
  const safeSiteName = escapeForJs(SITE_NAME);

  return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Referrer-Policy" content="no-referrer">
  <title>Checkout - ${safeSiteName}</title>
  <script src="https://js.payjsr.com/v1/payjsr.js"></script>
</head>
<body>
  <script>
    (function () {
      try { sessionStorage.setItem('payjsr_payment_id', '${safePaymentId}'); } catch (e) {}
      if (typeof PayJSR !== 'undefined' && PayJSR.openCheckout) {
        PayJSR.openCheckout('${safePaymentId}');
      } else {
        setTimeout(function () {
          if (typeof PayJSR !== 'undefined' && PayJSR.openCheckout) PayJSR.openCheckout('${safePaymentId}');
        }, 300);
      }
    })();
  </script>
</body>
</html>
  `);
}

function handlePayPalCheckout(req, res) {
  const { amount, currency = 'USD', success_url, cancel_url, product_name } = req.query;
  if (!amount || !success_url || !cancel_url) {
    return res.status(400).send('Missing required parameters');
  }

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).send('Invalid amount');
  }

  const paypalClientId = process.env.PAYPAL_CLIENT_ID;
  if (!paypalClientId) {
    return res.status(500).send('PayPal Client ID not configured. Set PAYPAL_CLIENT_ID in Render.');
  }

  applyCommonHeaders(res);
  res.setHeader('Permissions-Policy', 'interest-cohort=()');

  const currencyRaw = String(currency || 'USD').toUpperCase();
  const currencyCode = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';
  const paypalScriptUrl = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(paypalClientId)}&currency=${encodeURIComponent(currencyCode)}`;
  const displayName = product_name || 'Digital Ebook';
  const safeName = escapeForJs(displayName);
  const safeSuccess = escapeForJs(success_url);
  const safeCancel = escapeForJs(cancel_url);
  const safeBrand = escapeForJs(SITE_NAME);
  const amountStr = amountNum.toFixed(2);
  const pageTitle = escapeHtml(`${SITE_NAME} · Checkout`);
  const htmlBrand = escapeHtml(SITE_NAME);
  const htmlProduct = escapeHtml(String(displayName));

  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Referrer-Policy" content="no-referrer">
  <title>${pageTitle}</title>
  <style>
    :root {
      --bg-deep: #020617;
      --bg-mid: #030925;
      --paper: rgba(2, 8, 36, 0.94);
      --paper-border: rgba(129, 140, 248, 0.22);
      --primary: #ff3366;
      --accent: #00e5ff;
      --text: #e8e8e8;
      --muted: #9fb3ff;
      --muted2: rgba(148, 163, 184, 0.88);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Roboto', 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px 18px;
      background: linear-gradient(180deg, var(--bg-mid) 0%, var(--bg-deep) 50%, #000 100%);
      color: var(--text);
      position: relative;
      overflow-x: hidden;
    }
    .ambient {
      pointer-events: none;
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 90% 55% at 50% -25%, rgba(255, 51, 102, 0.2), transparent),
        radial-gradient(ellipse 55% 45% at 100% 40%, rgba(0, 229, 255, 0.07), transparent),
        radial-gradient(ellipse 45% 45% at 0% 85%, rgba(255, 51, 102, 0.09), transparent);
    }
    .wrap { width: 100%; max-width: 420px; position: relative; z-index: 1; }
    .card {
      position: relative;
      border-radius: 20px;
      background: var(--paper);
      border: 1px solid var(--paper-border);
      box-shadow:
        0 0 0 1px rgba(255, 51, 102, 0.07),
        0 24px 64px rgba(0, 0, 0, 0.55),
        0 0 100px rgba(255, 51, 102, 0.06);
      overflow: hidden;
      backdrop-filter: blur(12px);
    }
    .card-accent { height: 4px; width: 100%; background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .card-body { padding: 1.65rem 1.5rem 1.45rem; }
    .eyebrow {
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 0.3rem;
    }
    .brand {
      font-size: 1.32rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: var(--text);
      line-height: 1.2;
      margin-bottom: 0.65rem;
    }
    .badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.78rem;
      color: var(--muted2);
      margin-bottom: 0.95rem;
    }
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(129, 140, 248, 0.35), transparent);
      margin: 0.15rem 0 0.95rem;
    }
    .label {
      font-size: 0.62rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.3rem;
    }
    .product { font-size: 0.9rem; color: var(--text); line-height: 1.45; margin-bottom: 0.8rem; opacity: 0.93; }
    .amount {
      font-size: 2.1rem;
      font-weight: 800;
      letter-spacing: -0.04em;
      color: var(--primary);
      margin-bottom: 1.25rem;
      text-shadow: 0 0 48px rgba(255, 51, 102, 0.22);
    }
    .amount .cur-symbol { font-size: 1.25rem; opacity: 0.88; margin-right: 1px; }
    .amount .cur-code {
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--muted);
      margin-left: 6px;
      letter-spacing: 0.04em;
    }
    .pp-wrap {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(148, 163, 255, 0.14);
      border-radius: 16px;
      padding: 1rem 0.95rem 1.05rem;
    }
    .pp-label {
      font-size: 0.76rem;
      font-weight: 600;
      color: var(--muted2);
      text-align: center;
      margin-bottom: 0.6rem;
    }
    #paypal-button-container { min-height: 48px; }
    #loading { text-align: center; font-size: 0.78rem; color: var(--muted); margin-top: 0.7rem; }
    .fine {
      font-size: 0.66rem;
      line-height: 1.5;
      color: var(--muted2);
      text-align: center;
      margin-top: 0.55rem;
    }
  </style>
  <script src="${paypalScriptUrl}" data-namespace="paypal_sdk" referrerpolicy="no-referrer"></script>
</head>
<body>
  <div class="ambient" aria-hidden="true"></div>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Checkout</p>
        <h1 class="brand">${htmlBrand}</h1>
        <p class="badge"><span aria-hidden="true">🔒</span> Encrypted session · PayPal secure payment</p>
        <div class="divider" aria-hidden="true"></div>
        <p class="label">Your order</p>
        <p class="product">${htmlProduct}</p>
        <p class="amount"><span class="cur-symbol">$</span>${amountStr}<span class="cur-code">${escapeHtml(currencyCode)}</span></p>
        <div class="pp-wrap">
          <p class="pp-label">Pay with PayPal or card</p>
          <div id="paypal-button-container"></div>
        </div>
        <p class="fine" id="loading">Loading secure payment…</p>
        <p class="fine">After paying you will return to the store. Cancel opens a neutral page.</p>
      </div>
    </article>
  </div>
  <script>
    (function(){
      var SUCCESS_URL = '${safeSuccess}';
      var CANCEL_URL = '${safeCancel}';
      function initPayPal(){
        if (typeof paypal_sdk === 'undefined' || !paypal_sdk.Buttons) { setTimeout(initPayPal,100); return; }
        var el = document.getElementById('loading');
        if (el) el.style.display = 'none';
        paypal_sdk.Buttons({
          createOrder: function(data, actions) {
            return actions.order.create({
              purchase_units: [{
                description: '${safeName}',
                amount: { value: '${amountStr}', currency_code: '${currencyCode}' }
              }],
              application_context: {
                brand_name: '${safeBrand}',
                landing_page: 'NO_PREFERENCE',
                user_action: 'PAY_NOW'
              }
            });
          },
          onApprove: function(data, actions) {
            return actions.order.capture().then(function(details) {
              var sep = SUCCESS_URL.indexOf('?') >= 0 ? '&' : '?';
              var email = (details.payer && details.payer.email_address) ? encodeURIComponent(details.payer.email_address) : '';
              var firstName = (details.payer && details.payer.name && details.payer.name.given_name) ? details.payer.name.given_name : '';
              var lastName = (details.payer && details.payer.name && details.payer.name.surname) ? details.payer.name.surname : '';
              var fullName = encodeURIComponent((firstName + ' ' + lastName).trim());
              var payerId = (details.payer && details.payer.payer_id) ? details.payer.payer_id : '';
              window.location.replace(SUCCESS_URL + sep + 'order_id=' + encodeURIComponent(data.orderID) + '&payer_id=' + encodeURIComponent(payerId) + '&buyer_email=' + email + '&buyer_name=' + fullName);
            });
          },
          onCancel: function() { window.location.replace(CANCEL_URL); },
          onError: function(err) { console.error(err); alert('Payment could not be completed. Please try again.'); },
          style: { layout: 'vertical', color: 'blue', shape: 'pill', label: 'paypal', height: 48 }
        }).render('#paypal-button-container');
      }
      initPayPal();
    })();
  </script>
</body>
</html>`);
}

// Dispatcher: supports both methods.
// - method=paypal -> masked PayPal flow
// - method=payjsr -> PayJSR flow
// Default: paypal (preserves old behavior for existing callers).
app.get('/api/paypal-checkout', async (req, res) => {
  try {
    const method = String(req.query.method || 'paypal').toLowerCase();
    if (method === 'payjsr') {
      return await handlePayJSRCheckout(req, res);
    }
    return handlePayPalCheckout(req, res);
  } catch (err) {
    console.error('Checkout dispatch error:', err);
    return res.status(500).send('Checkout failed');
  }
});

// Explicit PayJSR endpoint (optional)
app.get('/api/payjsr-checkout', async (req, res) => {
  try {
    return await handlePayJSRCheckout(req, res);
  } catch (err) {
    console.error('PayJSR checkout error:', err);
    return res.status(500).send('Checkout failed');
  }
});

// Intermediary success page to forward to the original `success_url`
app.get('/api/payjsr-success', (req, res) => {
  try {
    const forward = String(req.query.forward || '');
    if (!forward) {
      return res.status(400).send('Missing forward URL');
    }

    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Processing…</title>
</head>
<body>
  <script>
    (function () {
      var forwardUrl = ${JSON.stringify(forward)};
      var paymentId = null;
      try { paymentId = sessionStorage.getItem('payjsr_payment_id'); } catch (e) {}

      var hasQuery = forwardUrl.indexOf('?') >= 0;
      var sep = hasQuery ? '&' : '?';

      if (paymentId) {
        window.location.href = forwardUrl + sep + 'order_id=' + encodeURIComponent(paymentId);
      } else {
        // If we lost sessionStorage for some reason, still forward.
        window.location.href = forwardUrl;
      }
    })();
  </script>
</body>
</html>
    `);
  } catch (err) {
    console.error('PayJSR success forward error:', err);
    res.status(500).send('Forward failed');
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', site: SITE_NAME });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SITE_NAME} running on port ${PORT}`);
});
