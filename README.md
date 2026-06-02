# ML Dashboard — Backend

API Express para o ML Dashboard SaaS. Roda no **Render**, banco **Neon.tech (PostgreSQL)**.

## Stack
- Node.js + Express 5
- TypeScript
- Prisma ORM → PostgreSQL (Neon.tech)
- bcryptjs, jsonwebtoken, cookie-parser, cors, axios

---

## Setup Local

```bash
npm install
cp .env.example .env
# Edite .env com suas credenciais

# Gere o Prisma client
npx prisma generate

# Com banco rodando, aplique o schema
npx prisma db push

# Popule com dados iniciais
npm run db:seed

# Inicie em desenvolvimento
npm run dev
```

---

## Deploy no Render

### 1. Crie o serviço

- Acesse render.com → **New → Web Service**
- Conecte o repositório do backend
- Configurações:
  - **Runtime:** Node
  - **Build Command:** `npm install && npx prisma generate && npm run build`
  - **Start Command:** `npm start`
  - **Instance Type:** Free (ou Starter para produção)

### 2. Variáveis de ambiente no Render

Vá em **Environment** no seu serviço e adicione:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | Connection string do Neon (pooled) |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | String aleatória longa (64+ chars) |
| `ADMIN_SECRET` | Segredo para criar o primeiro admin |
| `ADMIN_EMAIL` | E-mail do admin |
| `ADMIN_PASSWORD` | Senha inicial do admin |
| `ML_CLIENT_ID` | App ID do Mercado Livre |
| `ML_CLIENT_SECRET` | Secret do app ML |
| `ML_REDIRECT_URI` | `https://SEU-BACKEND.onrender.com/auth/callback` |
| `FRONTEND_URL` | `https://SEU-PROJETO.vercel.app` |
| `ALLOWED_ORIGINS` | `https://SEU-PROJETO.vercel.app` |

### 3. Banco Neon.tech

- Acesse neon.tech → crie um projeto → copie a **connection string (pooled)**
- Cole em `DATABASE_URL` no Render
- O Prisma aplicará as migrations automaticamente no build (`prisma migrate deploy`)

### 4. Seed inicial (primeiro deploy)

Após o primeiro deploy, abra o shell do Render e rode:
```bash
npm run db:seed
```
Ou use a rota de bootstrap:
```bash
curl -X POST https://SEU-BACKEND.onrender.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"secret":"SEU_ADMIN_SECRET","email":"admin@sua.com","password":"senha","name":"Admin"}'
```

### 5. Configurar URL do backend no Frontend (Vercel)

No projeto do frontend no Vercel, adicione:
- `BACKEND_URL` = `https://SEU-BACKEND.onrender.com`
- `NEXT_PUBLIC_BACKEND_URL` = `https://SEU-BACKEND.onrender.com`

### 6. Configurar OAuth ML

No painel de desenvolvedores ML:
- **Redirect URI:** `https://SEU-BACKEND.onrender.com/auth/callback`

---

## Estrutura

```
src/
  index.ts              → Entry point, Express setup, CORS, rotas
  routes/
    auth.ts             → Login, logout, me, OAuth ML
    sync.ts             → Sync de pedidos, preview, status
    dashboard.ts        → Stats, KPIs, gráfico mensal
    orders.ts           → Listagem + lucro por pedido
    shipments.ts        → Envios
    analytics.ts        → Analytics por período (Ouro+)
    costs.ts            → CRUD de preços de custo (Prata+)
    ml.ts               → Status e desconexão de contas ML
    employees.ts        → CRUD de funcionários + permissões
    settings.ts         → Preferências do usuário
    subscription.ts     → Dados de assinatura
    export.ts           → CSV de pedidos, lucro, custos (Premium)
    admin.ts            → Todas as rotas /admin/*
  middlewares/
    auth.ts             → requireAuth, requireAdmin, requirePlan, requireFeature, requireFuncionarioPermission
  lib/
    prisma.ts           → Singleton do Prisma client
    jwt.ts              → Sign/verify JWT
    ml.ts               → Cliente ML, refresh token, OAuth
    profit.ts           → Cálculo de lucro real por pedido
    filterMlAccounts.ts → Filtra contas ML acessíveis por role
    seed.ts             → Script de seed inicial
  jobs/
    alerts.ts           → Cron de geração de alertas automáticos
prisma/
  schema.prisma         → Schema completo do banco
```

---

## Rotas disponíveis

### Auth
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/auth/login` | Login com e-mail/senha |
| POST | `/auth/logout` | Logout (remove sessão) |
| GET | `/auth/me` | Usuário autenticado + plano |
| POST | `/auth/change-password` | Alterar senha |
| POST | `/auth/register` | Bootstrap admin (ADMIN_SECRET) |
| GET | `/auth/ml-url` | Gera URL OAuth ML |
| GET | `/auth/callback` | Callback OAuth ML |

### Dashboard & Dados
| Método | Rota | Plano |
|--------|------|-------|
| GET | `/dashboard/stats` | Todos |
| GET | `/sync/status` | Todos |
| GET | `/orders/sync` | Todos |
| GET | `/orders/sync/preview` | Premium |
| GET | `/orders` | Todos |
| GET | `/profit/orders` | Prata+ |
| GET | `/shipments` | Todos |
| GET | `/analytics` | Ouro+ |
| GET/POST | `/costs` | Prata+ |
| DELETE | `/costs/:id` | Prata+ |
| GET | `/ml/status` | Todos |
| DELETE | `/ml/disconnect/:tokenId` | Todos |
| GET/POST | `/employees` | Prata+ |
| PUT | `/employees/:id/permissions` | Ouro+ |
| PUT | `/employees/:id/ml-access` | Ouro+ |
| POST | `/employees/:id/toggle-active` | Prata+ |
| DELETE | `/employees/:id` | Prata+ |
| GET | `/subscription` | Lider |
| GET/POST | `/settings` | Todos |
| GET | `/export/orders` | Premium |
| GET | `/export/profit` | Premium |
| GET | `/export/costs` | Premium |

### Admin (`/admin/*`)
Todas requerem role `admin`.

| Método | Rota |
|--------|------|
| GET | `/admin/overview` |
| GET/POST | `/admin/clients` |
| GET/PUT | `/admin/clients/:id` |
| PUT | `/admin/clients/:id/plan` |
| PUT | `/admin/clients/:id/status` |
| POST | `/admin/clients/:id/reset-password` |
| DELETE | `/admin/clients/:id/subscription` |
| GET | `/admin/clients/:id/syncs` |
| GET/POST | `/admin/clients/:id/employees` |
| PUT | `/admin/clients/:id/employees/:eid/permissions` |
| PUT | `/admin/clients/:id/employees/:eid/ml-access` |
| POST | `/admin/clients/:id/employees/:eid/toggle-active` |
| GET | `/admin/subscriptions` |
| GET | `/admin/financial` |
| GET | `/admin/monitoring` |
| GET | `/admin/alerts` |
| PUT | `/admin/alerts/:id/resolve` |
| GET | `/admin/plans` |
| PUT | `/admin/plans/:id` |
