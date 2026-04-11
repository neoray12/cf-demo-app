# Openclaw SaaS Platform — Cloudflare Developer Platform 實作計畫

> **目標**：在 Cloudflare Developer Platform 上構建一個多租戶 SaaS 平台，讓使用者可以自助登入、一鍵 Provision 自己的 Openclaw 實例，並在管理後臺查看所有租戶狀態。

---

## 1. 系統架構總覽

```
┌─────────────────────────────────────────────────────────────────┐
│                        Custom Domain                            │
│              openclaw.example.com (Cloudflare Zone)             │
├──────────────┬──────────────────────────────┬───────────────────┤
│  前臺 (UI)    │    管理後臺 (Admin Dashboard)   │   API Layer       │
│  /app/*      │    /admin/*                   │   /api/*          │
├──────────────┴──────────────────────────────┴───────────────────┤
│                   Dispatch Worker (動態路由)                      │
│           env.DISPATCHER.get(tenantId).fetch(request)           │
├─────────────────────────────────────────────────────────────────┤
│                    Dispatch Namespace                            │
│      ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│      │ tenant-A │ │ tenant-B │ │ tenant-C │ │   ...    │       │
│      │ (User    │ │ (User    │ │ (User    │ │          │       │
│      │  Worker) │ │  Worker) │ │  Worker) │ │          │       │
│      └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
├─────────────────────────────────────────────────────────────────┤
│                     Storage & Services                          │
│  ┌────┐  ┌────┐  ┌────┐  ┌─────────┐  ┌─────────────────────┐ │
│  │ D1 │  │ R2 │  │ KV │  │ Durable │  │ Browser Rendering   │ │
│  │    │  │    │  │    │  │ Objects │  │ (Screenshot/Preview)│ │
│  └────┘  └────┘  └────┘  └─────────┘  └─────────────────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│  │ Sandbox  │  │ Workflows│  │ Queues   │                      │
│  │ (Beta)   │  │          │  │          │                      │
│  └──────────┘  └──────────┘  └──────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Cloudflare 組件清單與用途

| # | 組件 | 用途 | 必要性 |
|---|------|------|--------|
| 1 | **Workers** | 主要計算層：Dispatch Worker（路由）、API Worker（前後端 API）、Provisioning Worker | ✅ 必要 |
| 2 | **Workers for Platforms** | 多租戶核心：Dispatch Namespace + Dynamic Dispatch Worker，每個使用者的 Openclaw 作為 User Worker 部署 | ✅ 必要 |
| 3 | **D1** | 主資料庫：使用者帳號、租戶 metadata、provisioning 記錄、billing 資訊 | ✅ 必要 |
| 4 | **KV** | 快取層：Session tokens、hostname-to-tenant 路由映射、feature flags | ✅ 必要 |
| 5 | **R2** | 物件儲存：租戶資料備份檔案、靜態資產（前端 build artifacts）、匯出檔案 | ✅ 必要 |
| 6 | **Durable Objects** | 狀態管理：每個租戶的即時連線狀態、WebSocket session、rate limiting 計數器 | ✅ 必要 |
| 7 | **Browser Rendering** | 截圖預覽：為每個租戶的 Openclaw 產生 thumbnail/preview 截圖，用於後臺儀錶板 | ⭐ 推薦 |
| 8 | **Sandbox (Beta)** | 隔離執行：如需讓 Openclaw 執行使用者自訂程式碼，提供安全的容器化環境 | 🔶 視需求 |
| 9 | **Workflows** | 長時間任務編排：Provisioning 流程、D1 備份到 R2、定期健康檢查 | ⭐ 推薦 |
| 10 | **Queues** | 非同步任務：Provision 請求排隊、備份任務排隊、通知發送 | ⭐ 推薦 |
| 11 | **Custom Domains** | 自訂域名：主平臺 `openclaw.example.com`，可選支援租戶自訂域名 | ✅ 必要 |
| 12 | **Cloudflare for SaaS** | 如需支援租戶使用自己的 vanity domain（如 `app.customer.com`），自動 SSL 簽發 | 🔶 視需求 |
| 13 | **Workers AI + AI Gateway** | 如 Openclaw 包含 AI 功能（LLM 推理），可整合 Workers AI 及 AI Gateway 做 rate limit/logging | 🔶 視需求 |
| 14 | **Cron Triggers** | 定時任務：自動備份排程、過期租戶清理、使用量統計 | ⭐ 推薦 |

---

## 3. 專案結構（Monorepo）

```
openclaw-saas/
├── wrangler.jsonc                    # 主 Worker 設定
├── package.json
├── tsconfig.json
│
├── src/
│   ├── index.ts                      # 主 Worker 入口（路由分發）
│   │
│   ├── api/                          # API 路由
│   │   ├── auth.ts                   # 登入/註冊/OAuth
│   │   ├── provision.ts              # Provision Openclaw
│   │   ├── tenants.ts                # 租戶 CRUD
│   │   ├── backup.ts                 # 備份/還原
│   │   └── admin.ts                  # 管理後臺 API
│   │
│   ├── dispatch/                     # Workers for Platforms
│   │   ├── dispatch-worker.ts        # Dynamic Dispatch Worker
│   │   └── user-worker-template.ts   # User Worker 模板（Openclaw 核心邏輯）
│   │
│   ├── services/                     # 業務邏輯
│   │   ├── provisioning.ts           # Provisioning 流程管理
│   │   ├── screenshot.ts             # Browser Rendering 截圖
│   │   ├── backup-service.ts         # 備份到 R2
│   │   └── auth-service.ts           # 認證邏輯
│   │
│   ├── db/                           # D1 資料庫
│   │   ├── schema.sql                # DDL
│   │   └── migrations/               # 資料庫遷移
│   │
│   ├── durable-objects/              # Durable Objects
│   │   └── tenant-session.ts         # 租戶 Session DO
│   │
│   └── workflows/                    # Cloudflare Workflows
│       ├── provision-workflow.ts     # Provision 編排流程
│       └── backup-workflow.ts        # 備份編排流程
│
├── frontend/                         # 前臺 UI
│   ├── src/
│   │   ├── pages/
│   │   │   ├── login.tsx             # 登入頁
│   │   │   ├── dashboard.tsx         # 使用者儀錶板
│   │   │   ├── provision.tsx         # Provision 頁面
│   │   │   └── backup.tsx            # 備份管理頁面
│   │   └── components/
│   └── vite.config.ts
│
├── admin/                            # 管理後臺 UI
│   ├── src/
│   │   ├── pages/
│   │   │   ├── overview.tsx          # 總覽儀錶板
│   │   │   ├── tenants.tsx           # 租戶列表
│   │   │   ├── tenant-detail.tsx     # 租戶詳情
│   │   │   └── monitoring.tsx        # 監控面板
│   │   └── components/
│   └── vite.config.ts
│
└── scripts/
    ├── seed.ts                       # 初始資料
    └── deploy-user-worker.ts         # 部署 User Worker 腳本
```

---

## 4. 資料庫設計（D1）

```sql
-- 使用者表
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'admin'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 租戶/Openclaw 實例表
CREATE TABLE tenants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                          -- 租戶名稱
  slug TEXT NOT NULL UNIQUE,                   -- URL slug，也是 User Worker name
  status TEXT NOT NULL DEFAULT 'provisioning', -- 'provisioning' | 'active' | 'suspended' | 'deleted'
  worker_name TEXT,                            -- Dispatch Namespace 中的 Worker 名稱
  custom_domain TEXT,                          -- 可選：自訂域名
  config JSONB,                                -- Openclaw 配置
  screenshot_url TEXT,                         -- R2 中的截圖 URL
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 備份記錄表
CREATE TABLE backups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL,                        -- R2 object key
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'completed' | 'failed'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Session 表（可選，也可用 KV）
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Provisioning 日誌表
CREATE TABLE provision_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  step TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'started' | 'completed' | 'failed'
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_tenants_user_id ON tenants(user_id);
CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_backups_tenant_id ON backups(tenant_id);
CREATE INDEX idx_provision_logs_tenant_id ON provision_logs(tenant_id);
```

---

## 5. 核心流程設計

### 5.1 使用者認證流程

```
使用者 → /login → API Worker → 驗證密碼 (D1) → 產生 JWT → 存 KV Session → 返回 token
使用者 → /register → API Worker → 建立帳號 (D1) → 自動登入
使用者 → 每次請求 → Middleware 驗證 JWT → 從 KV 取 Session → 通過/拒絕
```

**認證方式選擇**：
- **方案 A（推薦）**：JWT + KV Session。Worker 簽發 JWT，KV 存 session metadata，支援 revoke。
- **方案 B**：整合第三方 OAuth（Google / GitHub），使用 Workers 做 OAuth callback handler。
- **方案 C**：Cloudflare Access（如果是內部使用）。

### 5.2 Provision 流程（Workflow 編排）

```
使用者點擊 "Provision"
  │
  ├─ Step 1: 建立 tenant 記錄（D1, status='provisioning'）
  │
  ├─ Step 2: 呼叫 Cloudflare API 部署 User Worker 到 Dispatch Namespace
  │           POST /accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script_name}
  │           Body: Openclaw Worker 程式碼 + Bindings（D1、KV、R2）
  │
  ├─ Step 3: 設定 KV 路由映射
  │           KV.put(`hostname:${slug}.openclaw.example.com`, tenantId)
  │
  ├─ Step 4: （可選）建立 Custom Hostname / DNS Record
  │
  ├─ Step 5: 用 Browser Rendering 截圖並存 R2
  │
  └─ Step 6: 更新 tenant 狀態（D1, status='active'）
```

**Workflow 實作**：
```typescript
export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(event: WorkflowEvent<ProvisionParams>, step: WorkflowStep) {
    const { userId, tenantName, slug } = event.payload;

    // Step 1: Create tenant record
    const tenantId = await step.do('create-tenant-record', async () => {
      const id = crypto.randomUUID();
      await this.env.DB.prepare(
        'INSERT INTO tenants (id, user_id, name, slug, status) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, userId, tenantName, slug, 'provisioning').run();
      return id;
    });

    // Step 2: Deploy User Worker to Dispatch Namespace
    await step.do('deploy-user-worker', async () => {
      const workerCode = generateOpenclawWorkerCode(tenantId, slug);
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${slug}`,
        {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${this.env.CF_API_TOKEN}` },
          body: createWorkerFormData(workerCode, tenantId),
        }
      );
      if (!res.ok) throw new Error(`Deploy failed: ${res.status}`);
    });

    // Step 3: Set routing
    await step.do('set-routing', async () => {
      await this.env.TENANT_ROUTES.put(`tenant:${slug}`, tenantId);
    });

    // Step 4: Take screenshot
    await step.do('take-screenshot', async () => {
      const screenshot = await this.env.BROWSER.fetch(
        `https://${slug}.openclaw.example.com`,
        { cf: { image: { format: 'png' } } }
      );
      await this.env.BACKUP_BUCKET.put(
        `screenshots/${tenantId}/preview.png`,
        screenshot.body
      );
    });

    // Step 5: Activate tenant
    await step.do('activate-tenant', async () => {
      await this.env.DB.prepare(
        'UPDATE tenants SET status = ?, worker_name = ?, updated_at = datetime("now") WHERE id = ?'
      ).bind('active', slug, tenantId).run();
    });
  }
}
```

### 5.3 Dispatch Worker（動態路由）

```typescript
// dispatch-worker.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 路由策略 1: 基於子域名
    // tenant-slug.openclaw.example.com → User Worker
    const hostname = url.hostname;
    const subdomain = hostname.split('.')[0];

    // 路由策略 2: 基於路徑
    // openclaw.example.com/t/tenant-slug/* → User Worker
    const pathMatch = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);

    const tenantSlug = pathMatch?.[1] || subdomain;

    // 從 KV 取得租戶資訊
    const tenantId = await env.TENANT_ROUTES.get(`tenant:${tenantSlug}`);
    if (!tenantId) {
      return new Response('Tenant not found', { status: 404 });
    }

    // 從 Dispatch Namespace 取得 User Worker
    const userWorker = env.DISPATCHER.get(tenantSlug);
    return userWorker.fetch(request);
  }
};
```

### 5.4 備份流程

```typescript
// backup-workflow.ts
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep) {
    const { tenantId, userId } = event.payload;

    // Step 1: 建立備份記錄
    const backupId = await step.do('create-backup-record', async () => {
      const id = crypto.randomUUID();
      const r2Key = `backups/${tenantId}/${id}.json`;
      await this.env.DB.prepare(
        'INSERT INTO backups (id, tenant_id, user_id, r2_key, status) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, tenantId, userId, r2Key, 'pending').run();
      return { id, r2Key };
    });

    // Step 2: 從 User Worker 匯出資料
    await step.do('export-data', async () => {
      const userWorker = this.env.DISPATCHER.get(tenantSlug);
      const exportRes = await userWorker.fetch(
        new Request('https://internal/export', { method: 'POST' })
      );
      const data = await exportRes.text();

      // 存到 R2
      await this.env.BACKUP_BUCKET.put(backupId.r2Key, data, {
        customMetadata: {
          tenantId,
          userId,
          createdAt: new Date().toISOString(),
        },
      });
    });

    // Step 3: 更新備份狀態
    await step.do('update-status', async () => {
      const obj = await this.env.BACKUP_BUCKET.head(backupId.r2Key);
      await this.env.DB.prepare(
        'UPDATE backups SET status = ?, size_bytes = ? WHERE id = ?'
      ).bind('completed', obj?.size || 0, backupId.id).run();
    });
  }
}
```

---

## 6. 前臺功能規格

### 6.1 登入/註冊頁（`/login`, `/register`）

| 功能 | 說明 |
|------|------|
| Email + Password 登入 | 表單驗證 → POST /api/auth/login → JWT |
| OAuth 登入 | Google / GitHub SSO（可選） |
| 註冊 | Email + Password → POST /api/auth/register |
| 忘記密碼 | 發送重設連結 |

### 6.2 使用者儀錶板（`/app/dashboard`）

| 功能 | 說明 |
|------|------|
| 我的 Openclaw 列表 | 顯示所有已 provision 的 instance，含狀態、截圖預覽、建立時間 |
| 一鍵 Provision | 填寫名稱/slug → POST /api/provision → 顯示 provisioning 進度 |
| 快捷操作 | 進入 Openclaw / 暫停 / 刪除 / 備份 |
| Provision 進度 | 即時顯示 Workflow 各 Step 狀態（可用 SSE 或輪詢） |

### 6.3 備份管理頁（`/app/backups`）

| 功能 | 說明 |
|------|------|
| 備份列表 | 按 tenant 分組，顯示時間、大小、狀態 |
| 手動備份 | 選擇 tenant → POST /api/backup → 觸發 Workflow |
| 下載備份 | 產生 R2 pre-signed URL → 直接下載 |
| 還原備份 | 選擇備份 → POST /api/backup/restore → 重新部署 User Worker |

### 6.4 Openclaw 實例頁面

使用者 provision 後進入的實際 Openclaw 應用（由 User Worker 渲染），依截圖功能推測應包含：
- Openclaw 核心功能介面
- 設定頁面
- 使用量統計

---

## 7. 管理後臺功能規格（`/admin/*`）

### 7.1 總覽儀錶板

| 指標 | 來源 |
|------|------|
| 總使用者數 | D1: `SELECT COUNT(*) FROM users` |
| 總租戶數 | D1: `SELECT COUNT(*) FROM tenants` |
| 活躍租戶數 | D1: `WHERE status = 'active'` |
| 今日新增 | D1: `WHERE created_at >= date('now')` |
| 備份總大小 | D1: `SUM(size_bytes) FROM backups` |

### 7.2 租戶管理列表

| 欄位 | 說明 |
|------|------|
| 租戶名稱 | 可點擊進入詳情 |
| 擁有者 (Email) | 關聯的 user |
| Slug / URL | `slug.openclaw.example.com` |
| 狀態 | provisioning / active / suspended / deleted |
| 截圖預覽 | Browser Rendering 產生的 thumbnail |
| 建立時間 | |
| 操作 | 暫停 / 恢復 / 刪除 / 查看日誌 |

### 7.3 租戶詳情頁

- 基本資訊（名稱、slug、owner、狀態、config）
- Provision 日誌時間軸
- 備份歷史
- 使用量統計（requests, CPU time — 從 Workers Analytics 取得）
- Worker 原始碼查看
- 手動操作（重新部署、強制備份、修改 config）

---

## 8. API 端點設計

```
Authentication:
  POST   /api/auth/register          # 註冊
  POST   /api/auth/login             # 登入
  POST   /api/auth/logout            # 登出
  GET    /api/auth/me                # 目前使用者

Tenants (User):
  GET    /api/tenants                # 列出我的租戶
  POST   /api/tenants                # 建立（Provision）租戶
  GET    /api/tenants/:id            # 取得租戶詳情
  PATCH  /api/tenants/:id            # 更新租戶設定
  DELETE /api/tenants/:id            # 刪除租戶
  GET    /api/tenants/:id/status     # 取得 Provision 進度

Backups (User):
  GET    /api/tenants/:id/backups    # 列出備份
  POST   /api/tenants/:id/backups    # 建立備份
  GET    /api/backups/:id/download   # 下載備份（pre-signed URL）
  POST   /api/backups/:id/restore   # 還原備份

Admin:
  GET    /api/admin/dashboard        # 總覽統計
  GET    /api/admin/tenants          # 所有租戶列表（含搜尋/篩選/分頁）
  GET    /api/admin/tenants/:id      # 租戶詳情
  PATCH  /api/admin/tenants/:id      # 管理操作（暫停/恢復）
  GET    /api/admin/users            # 使用者列表
  GET    /api/admin/logs             # 系統日誌

Screenshots:
  POST   /api/tenants/:id/screenshot # 手動觸發截圖更新
```

---

## 9. Wrangler 設定（`wrangler.jsonc`）

```jsonc
{
  "name": "openclaw-saas",
  "main": "src/index.ts",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],

  // Custom Domain
  "routes": [
    { "pattern": "openclaw.example.com/*", "custom_domain": true }
  ],

  // D1 Database
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "openclaw-db",
      "database_id": "<D1_DATABASE_ID>"
    }
  ],

  // KV Namespaces
  "kv_namespaces": [
    {
      "binding": "TENANT_ROUTES",
      "id": "<KV_NAMESPACE_ID>"
    },
    {
      "binding": "SESSIONS",
      "id": "<KV_NAMESPACE_ID>"
    }
  ],

  // R2 Buckets
  "r2_buckets": [
    {
      "binding": "BACKUP_BUCKET",
      "bucket_name": "openclaw-backups"
    },
    {
      "binding": "ASSETS_BUCKET",
      "bucket_name": "openclaw-assets"
    }
  ],

  // Workers for Platforms - Dispatch Namespace
  "dispatch_namespaces": [
    {
      "binding": "DISPATCHER",
      "namespace": "openclaw-production"
    }
  ],

  // Browser Rendering
  "browser": {
    "binding": "BROWSER"
  },

  // Durable Objects
  "durable_objects": {
    "bindings": [
      {
        "name": "TENANT_SESSION",
        "class_name": "TenantSession"
      }
    ]
  },

  // Workflows
  "workflows": [
    {
      "name": "provision-workflow",
      "binding": "PROVISION_WORKFLOW",
      "class_name": "ProvisionWorkflow"
    },
    {
      "name": "backup-workflow",
      "binding": "BACKUP_WORKFLOW",
      "class_name": "BackupWorkflow"
    }
  ],

  // Queues (可選)
  "queues": {
    "producers": [
      { "binding": "PROVISION_QUEUE", "queue": "openclaw-provision" }
    ],
    "consumers": [
      { "queue": "openclaw-provision", "max_batch_size": 10 }
    ]
  },

  // Cron Triggers
  "triggers": {
    "crons": [
      "0 2 * * *"  // 每天凌晨 2 點自動備份
    ]
  },

  // Environment Variables
  "vars": {
    "ENVIRONMENT": "production",
    "CF_ACCOUNT_ID": "<ACCOUNT_ID>"
  },

  // Secrets (via wrangler secret put)
  // CF_API_TOKEN - Cloudflare API Token
  // JWT_SECRET - JWT 簽名金鑰

  // Static Assets (前端)
  "assets": {
    "directory": "./frontend/dist",
    "binding": "ASSETS"
  }
}
```

---

## 10. 前端技術選型建議

| 項目 | 推薦 | 備註 |
|------|------|------|
| 框架 | **React + Vite** 或 **Astro** | 可用 Cloudflare Workers Static Assets 部署 |
| UI 元件庫 | **shadcn/ui** | 你熟悉的元件庫，配合 Tailwind CSS |
| 路由 | **React Router** 或 **TanStack Router** | SPA 模式 |
| 狀態管理 | **TanStack Query** | API 請求快取與狀態 |
| 圖表 | **Recharts** | 後臺儀錶板統計圖 |
| 認證 UI | 自建登入表單 | 配合 JWT API |

---

## 11. 開發與部署步驟

### Phase 1: 基礎設施（Week 1）
1. 建立 Cloudflare 帳號/Zone，設定 Custom Domain
2. 建立 D1 資料庫，執行 schema migration
3. 建立 KV namespace（TENANT_ROUTES, SESSIONS）
4. 建立 R2 bucket（openclaw-backups, openclaw-assets）
5. 建立 Workers for Platforms Dispatch Namespace（`openclaw-production`）
6. 設定 wrangler.jsonc 所有 bindings

### Phase 2: 認證系統（Week 1-2）
1. 實作 User 註冊/登入 API
2. JWT 簽發與驗證 middleware
3. Session 管理（KV）
4. 前端登入/註冊頁面

### Phase 3: Provisioning 核心（Week 2-3）
1. 設計 Openclaw User Worker 模板程式碼
2. 實作 Provisioning Workflow
3. 實作 Dispatch Worker 路由邏輯
4. 透過 Cloudflare API 部署 User Worker 到 Dispatch Namespace
5. 前端 Provision 頁面與進度追蹤

### Phase 4: 管理後臺（Week 3-4）
1. 管理後臺 Dashboard API
2. 租戶列表/詳情/操作 API
3. Browser Rendering 截圖整合
4. 管理後臺 UI 開發

### Phase 5: 備份功能（Week 4）
1. 備份 Workflow（User Worker → R2）
2. 下載備份（R2 pre-signed URL）
3. 還原備份流程
4. Cron Trigger 自動備份
5. 前端備份管理頁面

### Phase 6: 進階功能（Week 5+）
1. Cloudflare for SaaS — 租戶自訂域名支援
2. Sandbox 整合（如需要隔離執行環境）
3. Workers AI 整合
4. 使用量計費系統
5. 多語系支援
6. E2E 測試

---

## 12. 安全考量

| 面向 | 措施 |
|------|------|
| 認證 | JWT + HttpOnly Cookie，KV Session 支援 revoke |
| 授權 | RBAC（user / admin），API middleware 檢查角色 |
| 租戶隔離 | Workers for Platforms 原生隔離（V8 isolate），User Worker 跑在 untrusted mode |
| API 安全 | Rate limiting（Durable Objects 或 Cloudflare Rate Limiting Rules） |
| 資料加密 | HTTPS（Cloudflare 自動）、R2 備份可加密 |
| CSRF | SameSite cookie + CSRF token |
| 輸入驗證 | Zod schema validation |
| 管理後臺 | IP 白名單或 Cloudflare Access 保護 `/admin/*` |

---

## 13. 監控與可觀察性

| 工具 | 用途 |
|------|------|
| **Workers Analytics** | 請求量、錯誤率、CPU time |
| **Workers Logs (Logpush)** | 即時日誌推送到 R2/第三方 |
| **Workers for Platforms Observability** | 每個 User Worker 的 per-tenant metrics |
| **D1 Metrics** | 查詢量、資料庫大小 |
| **R2 Metrics** | 儲存量、操作次數 |
| **Provision Logs (D1)** | 自建 provisioning 流程日誌 |

---

## 14. 注意事項與限制

1. **Workers for Platforms** 需要 Workers Paid plan
2. **Sandbox** 目前是 Beta，API 可能變動
3. **Browser Rendering** 有並發 session 限制（Paid plan: 2 concurrent；Enterprise: higher）
4. **D1** 單資料庫最大 10GB（Paid plan），讀取量無限，寫入有 quota
5. **R2** 存取免 egress 費用，但 Class A/B 操作有計費
6. **Dispatch Namespace** 中的 User Worker 數量無限制
7. **Custom Domains** 需要 zone 在 Cloudflare 上
8. **Workflows** 目前是 Open Beta

---

## 15. 參考文件

- [Workers for Platforms - Get Started](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/)
- [Workers for Platforms - How it Works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Workers for Platforms - Hostname Routing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/)
- [Workers for Platforms - Dynamic Dispatch](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/)
- [Platform Starter Kit (Template)](https://github.com/cloudflare/templates/tree/main/worker-publisher-template)
- [AI Vibe Coding Platform Reference Architecture](https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-vibe-coding-platform/)
- [Browser Rendering - Quick Actions](https://developers.cloudflare.com/browser-rendering/quick-actions/)
- [Sandbox SDK (Beta)](https://developers.cloudflare.com/sandbox/)
- [Cloudflare for SaaS - Custom Hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/)
- [D1 Backup to R2 via Workflows](https://developers.cloudflare.com/workflows/examples/backup-d1/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
