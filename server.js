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

// Checkout PayJSR (mantém rota /api/paypal-checkout por compatibilidade com VideosPlus)
app.get('/api/paypal-checkout', async (req, res) => {
  try {
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

    // PayJSR expects amount in cents
    const amountCents = Math.round(amountNumber * 100);
    if (amountCents < 100) {
      return res.status(400).send('Amount too small (minimum is $1.00)');
    }

    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    const displayName = product_name || 'Digital Ebook';
    const escapeForJs = (s) =>
      String(s || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/`/g, '\\`')
        .replace(/\r/g, '')
        .replace(/\n/g, '');

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
      metadata: {
        product_name: String(displayName),
      },
    };

    // Create PayJSR payment
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
      return res.status(createRes.status).send(
        `Checkout failed (PayJSR): ${createData?.error || createData?.message || 'unknown error'}`,
      );
    }

    const paymentId = createData?.data?.payment_id || createData?.data?.paymentId || createData?.payment_id;
    if (!paymentId) {
      return res.status(502).send('Checkout failed (PayJSR): missing payment_id');
    }

    const safePaymentId = escapeForJs(paymentId);
    const safeSiteName = escapeForJs(SITE_NAME);

    // Open PayJSR checkout via JS SDK so we can persist `paymentId` in sessionStorage.
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Referrer-Policy" content="no-referrer">
  <title>Checkout - ${safeSiteName}</title>
  <script src="https://js.payjsr.com/v1/payjsr.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
      padding: 20px;
    }
    .container {
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 2rem;
      max-width: 420px;
      width: 100%;
      border: 1px solid rgba(255,255,255,0.1);
      text-align: center;
    }
    .brand { font-size: 1.1rem; color: #8b9dc3; margin-bottom: 0.5rem; }
    h1 { font-size: 1.3rem; margin-bottom: 0.5rem; }
    .loading { color: #888; margin-top: 0.9rem; font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">${safeSiteName}</div>
    <h1>Complete Your Purchase</h1>
    <div class="loading">Redirecting to PayJSR checkout…</div>
  </div>
  <script>
    (function () {
      try {
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, null, window.location.href);
        }
      } catch (e) {}

      // Persist payment id so /api/payjsr-success can append it to the original success_url.
      try {
        sessionStorage.setItem('payjsr_payment_id', '${safePaymentId}');
      } catch (e) {}

      // Open checkout. Redirect mode will send the buyer to success/cancel URLs.
      if (typeof PayJSR !== 'undefined' && PayJSR.openCheckout) {
        PayJSR.openCheckout('${safePaymentId}');
      } else {
        // Fallback: retry shortly if SDK isn't ready yet
        setTimeout(function () {
          if (typeof PayJSR !== 'undefined' && PayJSR.openCheckout) {
            PayJSR.openCheckout('${safePaymentId}');
          }
        }, 300);
      }
    })();
  </script>
</body>
</html>
    `);
  } catch (err) {
    console.error('PayJSR checkout error:', err);
    res.status(500).send('Checkout failed');
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
