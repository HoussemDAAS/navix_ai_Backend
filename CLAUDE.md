# CLAUDE.md Navix Backend (NestJS)

> This file is automatically read by Claude Code on every session.
> Read it fully before writing a single line of code.

---

## 🧠 Project Overview

**Navix** is a SaaS AI copilot for social media competitive intelligence and content co-creation.
The backend handles: auth, project management, orchestrating AI jobs via BullMQ, storing results, and exposing a REST API to the Next.js frontend.

The AI/LangGraph logic lives in a **separate Python FastAPI service** this backend calls it over HTTP and contains zero LLM code.

---

## 🎨 Figma Access

**You have access to the Figma file. Use it when you need to understand the data shapes or UI flows the backend must support.**

```
URL:     https://www.figma.com/design/alN6EZjApBjniPglloh7HK/Navix-Project
fileKey: alN6EZjApBjniPglloh7HK
```

When building an endpoint, look at the corresponding Figma screen to understand what data the UI needs this helps you return the right shape from your API without back-and-forth with the frontend.

---

## ✍️ Code Quality Rules NON-NEGOTIABLE

### Rule 1: No over-engineering
- No unnecessary abstraction layers
- No generic base classes unless there is actual, proven repetition
- No "enterprise patterns" for things that can be written simply
- No premature optimization
- If something works simply keep it simple

### Rule 2: No sloppy/easy code
- No `// TODO` left unfixed
- No unhandled edge cases
- No missing error handling every async call is wrapped in try/catch
- No skipped validation on inputs
- Every endpoint returns the correct HTTP status code

### Rule 3: Clean and direct
- Every module does one thing
- Every service method does one thing
- Short, clear method names
- No commented-out code
- No `console.log` use NestJS `Logger`

### TypeScript
- No `any` ever
- All DTOs fully typed and validated
- Return types explicit on service methods
- Prisma types used directly don't re-declare what Prisma already gives you

---

## 🗂️ Repository Structure

```
navix-backend/
├── src/
│   ├── main.ts                     # Bootstrap, Swagger, global pipes
│   ├── app.module.ts
│   ├── config/
│   │   ├── database.config.ts
│   │   ├── redis.config.ts
│   │   └── jwt.config.ts
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── strategies/
│   │   │   ├── jwt.strategy.ts
│   │   │   └── refresh.strategy.ts
│   │   └── dto/
│   │       ├── register.dto.ts
│   │       └── login.dto.ts
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.service.ts
│   │   └── entities/user.entity.ts
│   ├── projects/
│   │   ├── projects.module.ts
│   │   ├── projects.controller.ts
│   │   ├── projects.service.ts
│   │   └── dto/
│   ├── brand-kit/
│   ├── competitors/
│   ├── analysis/
│   ├── directions/
│   ├── drafts/
│   │   ├── drafts.module.ts
│   │   ├── drafts.controller.ts
│   │   ├── drafts.service.ts
│   │   └── dto/
│   │       ├── update-draft.dto.ts
│   │       └── feedback.dto.ts
│   ├── calendar/
│   ├── jobs/
│   │   ├── jobs.module.ts
│   │   ├── jobs.controller.ts      # GET /jobs/:id/status
│   │   ├── jobs.service.ts
│   │   ├── processors/
│   │   │   ├── competitors.processor.ts
│   │   │   ├── analysis.processor.ts
│   │   │   ├── directions.processor.ts
│   │   │   └── drafts.processor.ts
│   │   └── queues.ts               # Queue name constants
│   ├── ai/
│   │   └── ai.service.ts           # HTTP client to FastAPI AI service
│   └── common/
│       ├── guards/
│       │   └── jwt-auth.guard.ts
│       ├── decorators/
│       │   └── current-user.decorator.ts
│       ├── interceptors/
│       │   └── logging.interceptor.ts
│       └── filters/
│           └── http-exception.filter.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── test/
```

---

## ⚙️ Tech Stack

```json
{
  "framework": "NestJS v10",
  "language": "TypeScript",
  "orm": "Prisma",
  "database": "PostgreSQL",
  "queue": "BullMQ + Redis",
  "auth": "JWT (access + refresh tokens)",
  "docs": "Swagger via @nestjs/swagger",
  "validation": "class-validator + class-transformer",
  "http-client": "Axios (to call AI service)"
}
```

---

## 🗃️ Database Schema (Supabase — NOT Prisma)

**Important**: This project uses Supabase directly via `SupabaseService.getClient()`, NOT Prisma.
The Prisma schema below is reference only for the table structure. All queries use the Supabase JS client.

### Profiles table (Supabase, RLS enabled)
```sql
profiles (
  id                    uuid PK → auth.users(id)
  full_name             text
  avatar_url            text
  biography             text
  persona               text CHECK (ecommerce | agency | creator)
  instagram_handle      text
  tiktok_handle         text
  youtube_handle        text
  followers_count       integer
  following_count       integer
  posts_count           integer
  is_verified           boolean DEFAULT false
  onboarding_completed  boolean NOT NULL DEFAULT false
  created_at            timestamptz
  updated_at            timestamptz
)
-- Auto-created on signup via trigger: handle_new_user()
```

### Other tables (reference)
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  name         String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  projects     Project[]
}

model Project {
  id          String        @id @default(uuid())
  userId      String
  user        User          @relation(fields: [userId], references: [id])
  name        String
  niche       String?
  country     String?
  language    String        @default("en")
  objectives  String[]
  channels    String[]
  status      ProjectStatus @default(SETUP)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  brandKit    BrandKit?
  competitors Competitor[]
  analyses    Analysis[]
  directions  Direction[]
  drafts      Draft[]
  calendar    CalendarItem[]
  jobs        Job[]
}

enum ProjectStatus {
  SETUP
  BRAND_KIT
  COMPETITORS
  ANALYSIS
  CO_CREATION
  CALENDAR
  COMPLETE
}

model BrandKit {
  id              String   @id @default(uuid())
  projectId       String   @unique
  project         Project  @relation(fields: [projectId], references: [id])
  tone            String?
  formalityLevel  String?
  vocabInclude    String[]
  vocabExclude    String[]
  promise         String?
  differentiation String?
  offers          String[]
  objections      String[]
  forbiddenClaims String[]
  internalRules   String[]
  examplePosts    Json[]
  preferredTones  String[]
  avoidPatterns   String[]
  preferredCTAs   String[]
  acceptedStyles  String[]
  memoryVersion   Int      @default(1)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model Competitor {
  id              String   @id @default(uuid())
  projectId       String
  project         Project  @relation(fields: [projectId], references: [id])
  handle          String
  platform        String   @default("instagram")
  niche           String?
  dominantFormat  String?
  confidenceScore Float
  inclusionReason String
  tags            String[]
  validatedByUser Boolean  @default(false)
  rejectedByUser  Boolean  @default(false)
  createdAt       DateTime @default(now())
}

model Analysis {
  id              String   @id @default(uuid())
  projectId       String
  project         Project  @relation(fields: [projectId], references: [id])
  dominantFormats Json
  recurringAngles Json
  dominantHooks   String[]
  dominantCTAs    String[]
  avgCadence      String?
  opportunities   Json
  saturatedAreas  Json
  coverageNote    String
  recommendations Json
  createdAt       DateTime @default(now())
}

model Direction {
  id            String   @id @default(uuid())
  projectId     String
  project       Project  @relation(fields: [projectId], references: [id])
  pillar        String
  angle         String
  format        String
  hook          String
  cta           String
  justification String
  selected      Boolean  @default(false)
  createdAt     DateTime @default(now())
  drafts        Draft[]
}

model Draft {
  id          String      @id @default(uuid())
  projectId   String
  project     Project     @relation(fields: [projectId], references: [id])
  directionId String?
  direction   Direction?  @relation(fields: [directionId], references: [id])
  caption     String
  videoPlan   Json?
  altHooks    String[]
  altCTAs     String[]
  status      DraftStatus @default(PENDING)
  userEdits   String?
  feedbacks   Feedback[]
  scheduledFor DateTime?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
}

enum DraftStatus {
  PENDING
  APPROVED
  REJECTED
  EDITED
}

model Feedback {
  id        String   @id @default(uuid())
  draftId   String
  draft     Draft    @relation(fields: [draftId], references: [id])
  action    String   // approved | rejected | edited
  notes     String?
  createdAt DateTime @default(now())
}

model CalendarItem {
  id          String   @id @default(uuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
  draftId     String?
  title       String
  scheduledAt DateTime
  platform    String   @default("instagram")
  status      String   @default("planned")
  createdAt   DateTime @default(now())
}

model Job {
  id          String    @id @default(uuid())
  projectId   String
  project     Project   @relation(fields: [projectId], references: [id])
  bullJobId   String?
  type        JobType
  status      JobStatus @default(PENDING)
  input       Json?
  output      Json?
  error       String?
  startedAt   DateTime?
  completedAt DateTime?
  createdAt   DateTime  @default(now())
}

enum JobType {
  COMPETITOR_DISCOVERY
  MARKET_ANALYSIS
  DIRECTION_GENERATION
  DRAFT_GENERATION
  BRAND_MEMORY_UPDATE
}

enum JobStatus {
  PENDING
  ACTIVE
  COMPLETED
  FAILED
}
```

---

## 🔌 REST API Endpoints

### Auth
Auth is handled by Supabase (not custom JWT). Backend validates Supabase JWT via `SupabaseAuthGuard`.
Frontend sends `Authorization: Bearer <supabase_access_token>`.

### Profiles (NEW)
```
GET   /profiles/me         → current user's profile
PATCH /profiles/me         → update profile fields (persona, handles, onboarding_completed, etc.)
```
- `profiles` table auto-created per user via DB trigger on signup
- `onboarding_completed` can only be set to `true` (never back to `false`)

### Projects
```
GET   /projects
POST  /projects
GET   /projects/:id
PATCH /projects/:id
DELETE /projects/:id
```

### Brand Kit
```
GET   /projects/:id/brand-kit
POST  /projects/:id/brand-kit
```

### Competitors
```
POST  /projects/:id/competitors/discover   → 202 { jobId }
GET   /projects/:id/competitors
PATCH /projects/:id/competitors/:cId       → validate/reject
DELETE /projects/:id/competitors/:cId
```

### Analysis
```
POST  /projects/:id/analysis/run           → 202 { jobId }
GET   /projects/:id/analysis
```

### Directions
```
POST  /projects/:id/directions/generate    → 202 { jobId }
GET   /projects/:id/directions
PATCH /projects/:id/directions/:dId        → { selected: true }
```

### Drafts
```
POST  /projects/:id/drafts/generate        → 202 { jobId }
GET   /projects/:id/drafts
PATCH /projects/:id/drafts/:dId            → { status, userEdits, caption, videoPlan }
POST  /projects/:id/drafts/:dId/feedback   → { action, notes }
```

### Calendar
```
GET   /projects/:id/calendar
POST  /projects/:id/calendar/export
```

### Jobs
```
GET   /jobs/:jobId/status                  → { status, progress, result?, error? }
```

---

## 🔄 BullMQ Job Flow

Every heavy AI operation follows the same pattern:

```
1. Controller receives POST
2. Service creates Job record in DB (status: PENDING)
3. Service enqueues job to BullMQ with payload
4. Controller returns 202 { jobId } immediately
5. Processor picks up job:
   a. Set Job status → ACTIVE
   b. Call AI service (FastAPI) via ai.service.ts
   c. Parse structured JSON response
   d. Persist results to DB
   e. Set Job status → COMPLETED or FAILED
6. Frontend polls GET /jobs/:jobId/status every 2s
```

### Queue names
```ts
// src/jobs/queues.ts
export const QUEUES = {
  COMPETITORS:   'competitor-discovery',
  ANALYSIS:      'market-analysis',
  DIRECTIONS:    'direction-generation',
  DRAFTS:        'draft-generation',
  BRAND_MEMORY:  'brand-memory',
} as const
```

---

## 🤖 AI Service Integration

```ts
// src/ai/ai.service.ts
// Base URL from env: AI_SERVICE_URL (e.g. http://localhost:8000)

// FastAPI endpoints:
POST /agents/competitor-discovery    { seed, niche, country, brandKit }
POST /agents/market-analysis         { competitors[], brandKit }
POST /agents/direction-generation    { analysis, brandKit, objectives }
POST /agents/draft-generation        { directions[], brandKit }
POST /agents/brand-memory-update     { feedback[], currentBrandKit }

// All return structured JSON
// Timeout: 120s
// On timeout: mark job FAILED, propagate error to frontend
```

---

## 🔐 Security

- All routes except `/auth/*` require `@UseGuards(JwtAuthGuard)`
- All project-scoped routes require ownership check in the service layer
- JWT access token: 15min refresh token: 7 days (httpOnly cookie)
- Rate limiting: 100 req/min per user via `@nestjs/throttler`
- All secrets in `.env` never hardcoded
- Log all critical events (job start, fail, auth events)

---

## 📋 Environment Variables

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/navix
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=your-secret
JWT_REFRESH_SECRET=your-refresh-secret
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
AI_SERVICE_URL=http://localhost:8000
PORT=3001
NODE_ENV=development
```

---

## 🧩 Code Patterns

### DTO always validate
```ts
import { IsString, IsEmail, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class RegisterDto {
  @ApiProperty()
  @IsString()
  name: string

  @ApiProperty()
  @IsEmail()
  email: string

  @ApiProperty()
  @MinLength(8)
  password: string
}
```

### Service always check ownership
```ts
async getProject(projectId: string, userId: string) {
  const project = await this.prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new NotFoundException('Project not found')
  if (project.userId !== userId) throw new ForbiddenException()
  return project
}
```

### Processor always handle errors
```ts
@Processor(QUEUES.COMPETITORS)
export class CompetitorProcessor {
  @Process()
  async handle(job: Job<CompetitorJobPayload>) {
    try {
      await this.jobsService.setActive(job.data.jobId)
      const result = await this.aiService.discoverCompetitors(job.data)
      await this.competitorsService.saveResults(job.data.projectId, result)
      await this.jobsService.setCompleted(job.data.jobId, result)
    } catch (error) {
      await this.jobsService.setFailed(job.data.jobId, error.message)
      throw error // BullMQ needs this to mark job as failed
    }
  }
}
```

---

## 🏗️ Brand Memory Logic

After each feedback batch, trigger BRAND_MEMORY job:
```
Input:  all project feedback + current BrandKit
Output: updated BrandKit fields:
  - preferredTones    (from approved draft patterns)
  - avoidPatterns     (from rejected/edited notes)
  - preferredCTAs     (from approved CTAs)
  - acceptedStyles    (from approval history)
  - memoryVersion++
Persist updated fields back to BrandKit table
```

---

## 📊 Observability

- Use NestJS `Logger` never `console.log`
- Log: job start, job end, job fail, AI service calls, auth events
- Every job log includes: jobId, projectId, userId, duration
- Store all job inputs/outputs in Job table for debugging and reproducibility

---

## ✅ Definition of Done (per endpoint)

- [ ] DTO validated with class-validator
- [ ] Swagger annotated (@ApiOperation, @ApiResponse)
- [ ] Ownership check present on all project-scoped routes
- [ ] Unit test for service layer happy path
- [ ] Integration test for end-to-end happy path
- [ ] All error cases return correct HTTP codes (400/401/403/404/500)
- [ ] Logged with NestJS Logger
- [ ] No `any`, no `console.log`, no unhandled promises
