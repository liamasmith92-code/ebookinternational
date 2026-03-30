# Ebooks Checkout Site

Site de ebooks para hospedagem no Render. Funciona como **front/máscara** do checkout PayJSR — quando o provedor de pagamento verifica a origem, veem este domínio de ebooks.

## Deploy no Render

1. Crie conta em [render.com](https://render.com)
2. **New** → **Web Service**
3. Conecte o repositório (pode ser um subdiretório ou repo separado com este código)
4. Configuração:
   - **Root Directory**: `ebooks-site` (se estiver dentro do repo principal)
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free

5. **Environment Variables** no Render:
   - `SITE_NAME` — Nome do site (ex: "Readify Books", "BookVault")
   - `PAYJSR_SECRET_KEY` — Secret key do PayJSR (`sk_live_...` ou `sk_test_...`)

6. Após o deploy, copie a URL (ex: `https://ebooks-checkout.onrender.com`)

## Configurar no VideosPlus (Railway)

No painel do Railway, adicione:

- `VITE_CHECKOUT_URL` = `https://seu-ebooks-site.onrender.com` (sem barra no final)

O VideosPlus passará a usar esta URL para o checkout PayJSR em vez da API principal.

## Endpoints

- `GET /` — Landing page com ebooks fictícios
- `GET /api/paypal-checkout?amount=&currency=&success_url=&cancel_url=&product_name=` — Checkout PayJSR (mantido o path por compatibilidade)
- `GET /api/health` — Health check
