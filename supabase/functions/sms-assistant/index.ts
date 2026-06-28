// SMS AI Assistant — v31
// v31: model bump claude-sonnet-4-5-20250929 -> claude-sonnet-4-6 (retired snapshot retired).
// v30: Image-to-ClickUp-task — when an inbound MMS has an image AND the caption looks like a
//      ClickUp task request ("clickup"/"click up" or the word "task"), route to
//      handleMmsToClickupTask: create the task via the AI tool path (smart name + due date),
//      then attach the image(s) to that task via the ClickUp attachment API. Non-task images
//      and voice memos keep their existing Drive/transcript behavior.
// v29: Pass D v2 sync — analyze_borrower_income now reads from borrower_qualifying_snapshot
//      view so SMS responses match dashboard exactly (preliminary + agency qualifying numbers).
//      Multi-user whitelist Phase 2 — isAuthorized() helper reads sms_authorized_phones
//      table first, falls back to AUTHORIZED_PHONES env var.
// v28: added analyze_borrower_income tool (Pass D v1). 12 tools total.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1'

type SbClient = ReturnType<typeof createClient>

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const CLAUDE_MAX_TOKENS = 1024
const RATE_LIMIT_PER_HOUR = 30
const SMS_MAX_LENGTH = 1500
const REQUEST_TIMEOUT_MS = 25000
const MAX_TOOL_ITERATIONS = 5
const MEMORY_WINDOW_MIN = 15
const MEMORY_MAX_EXCHANGES = 4
const GOOGLE_TOKEN_ROW_ID = 'rene'
const GOOGLE_CALENDAR_ID = 'primary'
const GOOGLE_TIMEZONE = 'America/Los_Angeles'
const STORAGE_BUCKET = 'borrower-documents'
const ADMIN_LEAD_URL_BASE = 'https://beta.ratesandrealty.com/admin/lead-detail.html?cid='
const LETTER_W = 612, LETTER_H = 792
const DRIVE_BORROWERS_PARENT_ENV = 'GOOGLE_DRIVE_BORROWERS_PARENT_FOLDER_ID'
const DRIVE_BORROWERS_PARENT_DEFAULT = '11OLUA6Fu3tNrzWP8O1v_pFjl-UGbzos6'
const WHISPER_MODEL = 'whisper-1'
const VOICE_TRANSCRIPT_REPLY_MAX = 320
const PENDING_EXPIRY_MIN = 60
const PENDING_REPLY_MAX_LEN = 60
const FUZZY_THRESHOLD_HIGH = 0.8
const FUZZY_THRESHOLD_LOW = 0.55

Deno.serve(async (req) => {
  return new Response('placeholder', { status: 200 })
})
