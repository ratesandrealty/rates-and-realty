import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GDRIVE_BORROWERS_ROOT = '11OLUA6Fu3tNrzWP8O1v_pFjl-UGbzos6';
const GDRIVE_LENDERS_ROOT   = '1Pg6GkbwzgiIp3PfZqP4oXycw7tLKUN8p';
const GDRIVE_GUIDELINES_ROOT= '1lHCzRSy5Louw9N2ooqjdfnDXNLKYVniM';
const GDRIVE_BASE = 'https://drive.google.com/drive/folders/';

/* KNOWN_BORROWER_FOLDERS AND ITS MATCHER WERE REMOVED 2026-08-19.
 *
 * The map held NINE REAL BORROWER NAMES hardcoded in source -- several with
 * the loan type in the key ("… refi", "… heloc", "… buyer") -- together with
 * the Drive folder id for each. This function has no caller authentication of
 * any kind, so search_borrower_folder returned that entire list, deduped, to
 * ANY anonymous caller: measured, HTTP 200 with no credential at all.
 *
 * It was also wrong. The fallback arm matched on last name alone --
 *     if (key.includes(last)) return { ...val, name: key };
 * -- and normalize("") is "", which every key contains. So a contact with an
 * empty last name matched the FIRST entry in the map, and the API default is
 * auto_save = true, which writes that folder id onto the contact. A borrower
 * with no surname would have been linked to a different borrower's documents.
 * The UI never triggered it (lead-detail passes auto_save:false), so this was
 * a live defect reachable only by calling the function directly -- which
 * anyone could.
 *
 * NOTHING REPLACES IT, deliberately. The real mechanism is
 * contacts.gdrive_folder_id, checked first in findOrCreateBorrowerFolder and
 * untouched by this change: a contact whose folder is linked still resolves.
 * What is lost is a convenience for nine hardcoded people; every other
 * contact already took the create-a-folder path, which is what they now get
 * too. If folder discovery by name is wanted again it belongs in Drive (a
 * files.list query against the Borrowers root) or in a table -- not in a
 * constant that ages, cannot be corrected without a deploy, and is served to
 * the public.
 */

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json();
    const { action } = body;
    if (action === 'find_or_create_borrower_folder') return await findOrCreateBorrowerFolder(body);
    if (action === 'link_folder_to_contact') return await linkFolderToContact(body);
    if (action === 'get_drive_config') return await getDriveConfig();
    if (action === 'search_borrower_folder') return await searchBorrowerFolder(body);
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors });
  } catch(e: any) {
    console.error('borrower-drive error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});

// Main function: search existing folders, return match or signal to create new
async function findOrCreateBorrowerFolder(body: any) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { contact_id, first_name, last_name, auto_save = true } = body;

  // 1. Check if contact already has a folder linked
  if (contact_id) {
    const { data: contact } = await sb.from('contacts')
      .select('id,first_name,last_name,gdrive_folder_id,gdrive_folder_url,gdrive_folder_name')
      .eq('id', contact_id).single();
    
    if (contact?.gdrive_folder_id) {
      return new Response(JSON.stringify({
        success: true,
        found: true,
        already_linked: true,
        folder_id: contact.gdrive_folder_id,
        folder_url: contact.gdrive_folder_url,
        folder_name: contact.gdrive_folder_name,
        message: `Already linked to Drive folder`
      }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }

  /* 2. NO NAME SEARCH ANY MORE. The only source of "an existing folder for this
     borrower" was the hardcoded map removed above, so every contact whose
     gdrive_folder_id is unset now takes the create-a-folder path below -- which
     is the path all but nine of them already took.

     `auto_save` survives in the request shape and now governs nothing, because
     the only write it ever gated was the one that linked a guessed folder. It is
     left accepted-and-ignored rather than rejected so the existing caller keeps
     working unchanged; lead-detail sends auto_save:false. */
  const fn = first_name || '';
  const ln = last_name || '';

  // 3. No existing folder found — return instructions to create one
  // (Actual folder creation requires Google Drive API write access via OAuth)
  // We return the folder name to use and the parent folder to create it in
  const suggestedName = `${fn} ${ln}`.trim();
  const createUrl = `https://drive.google.com/drive/folders/${GDRIVE_BORROWERS_ROOT}`;

  return new Response(JSON.stringify({
    success: true,
    found: false,
    folder_id: null,
    folder_url: null,
    suggested_folder_name: suggestedName,
    parent_folder_id: GDRIVE_BORROWERS_ROOT,
    parent_folder_url: createUrl,
    message: `No existing folder found. Create a new folder named "${suggestedName}" in the Borrowers Drive folder.`,
    action_needed: 'create_folder',
    drive_root: createUrl
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Search only — don't auto-link
/* THIS ACTION WAS THE DISCLOSURE. It answered a no-match by returning
   `all_known_folders` -- every borrower name and Drive folder id in the map --
   and nothing authenticates this function, so an anonymous POST received the
   lot. Measured before the fix: HTTP 200 with no credential, nine names.

   The action is KEPT rather than deleted so an unknown caller gets an honest
   negative instead of "Unknown action", but it has nothing left to search and
   never enumerates anything. No repo caller invokes it; the lead-detail modal
   uses find_or_create_borrower_folder. */
async function searchBorrowerFolder(_body: any) {
  return new Response(JSON.stringify({
    success: true, found: false,
    message: 'Folder search by name is no longer available. Link a folder explicitly with link_folder_to_contact, or open the Borrowers Drive folder.',
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Manually link a folder ID to a contact
async function linkFolderToContact(body: any) {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { contact_id, folder_id, folder_url, folder_name } = body;
  if (!contact_id || !folder_id) {
    return new Response(JSON.stringify({ error: 'contact_id and folder_id required' }), { status: 400, headers: cors });
  }
  const url = folder_url || `${GDRIVE_BASE}${folder_id}`;
  await sb.from('contacts').update({
    gdrive_folder_id: folder_id,
    gdrive_folder_url: url,
    gdrive_folder_name: folder_name || null
  }).eq('id', contact_id);

  return new Response(JSON.stringify({ success: true, folder_url: url }), {
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

async function getDriveConfig() {
  return new Response(JSON.stringify({
    success: true,
    borrowers: { folder_id: GDRIVE_BORROWERS_ROOT, folder_url: `${GDRIVE_BASE}${GDRIVE_BORROWERS_ROOT}` },
    lenders:   { folder_id: GDRIVE_LENDERS_ROOT,   folder_url: `${GDRIVE_BASE}${GDRIVE_LENDERS_ROOT}` },
    guidelines:{ folder_id: GDRIVE_GUIDELINES_ROOT, folder_url: `${GDRIVE_BASE}${GDRIVE_GUIDELINES_ROOT}` },
    known_borrower_folders: 0
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}
