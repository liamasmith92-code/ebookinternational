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

  const paypalClientId = process.env.PAYPAL_CLIENT_ID;
  if (!paypalClientId) {
    return res.status(500).send('PayPal Client ID not configured. Set PAYPAL_CLIENT_ID in Render.');
  }

  applyCommonHeaders(res);

  const paypalScriptUrl = `https://www.paypal.com/sdk/js?client-id=${paypalClientId}&currency=USD`;
  const displayName = product_name || 'Digital Ebook';
  const safeName = escapeForJs(displayName);
  const safeSuccess = escapeForJs(success_url);
  const safeCancel = escapeForJs(cancel_url);
  const safeBrand = escapeForJs(SITE_NAME);

  return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Referrer-Policy" content="no-referrer">
  <title>Checkout - ${SITE_NAME}</title>
  <script src="${paypalScriptUrl}" data-namespace="paypal_sdk" referrerpolicy="no-referrer"></script>
</head>
<body>
  <script>
    (function(){
      var SUCCESS_URL = '${safeSuccess}';
      var CANCEL_URL = '${safeCancel}';
      function initPayPal(){
        if (typeof paypal_sdk === 'undefined' || !paypal_sdk.Buttons) { setTimeout(initPayPal,100); return; }
        paypal_sdk.Buttons({
          createOrder: function(data, actions) {
            return actions.order.create({
              purchase_units: [{
                description: '${safeName}',
                amount: { value: '${parseFloat(amount).toFixed(2)}', currency_code: '${currency}' }
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
              window.location.href = SUCCESS_URL + sep + 'order_id=' + data.orderID + '&payer_id=' + payerId + '&buyer_email=' + email + '&buyer_name=' + fullName;
            });
          },
          onCancel: function() { window.location.href = CANCEL_URL; },
          onError: function(err) { console.error(err); alert('Payment error. Please try again.'); },
          style: { layout: 'vertical', color: 'blue', shape: 'rect', label: 'paypal' }
        }).render(document.body);
      }
      initPayPal();
    })();
  </script>
</body>
</html>
  `);
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
