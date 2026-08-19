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

// Known borrower folders from Drive (pre-seeded from existing folders)
const KNOWN_BORROWER_FOLDERS: Record<string, {id:string, url:string}> = {
  'jose joey cruz':       { id:'1Wl8j-OOlsDOXGHWCJkwXzWs6QhdGx6SS', url:'https://drive.google.com/drive/folders/1Wl8j-OOlsDOXGHWCJkwXzWs6QhdGx6SS' },
  'patricio garces':      { id:'1e89tt-iuuhBLBrxgUN0BpVNjEM9qzYAt', url:'https://drive.google.com/drive/folders/1e89tt-iuuhBLBrxgUN0BpVNjEM9qzYAt' },
  'erika enciso refi':    { id:'1HbGAmJmvkWjf8zxeHJ3fLOjuDsW7NfJo', url:'https://drive.google.com/drive/folders/1HbGAmJmvkWjf8zxeHJ3fLOjuDsW7NfJo' },
  'erika enciso':         { id:'1HbGAmJmvkWjf8zxeHJ3fLOjuDsW7NfJo', url:'https://drive.google.com/drive/folders/1HbGAmJmvkWjf8zxeHJ3fLOjuDsW7NfJo' },
  'ismael mora docs':     { id:'1o8ofJXnQHAt8hsjfVzXkGLkcSZajNW9m', url:'https://drive.google.com/drive/folders/1o8ofJXnQHAt8hsjfVzXkGLkcSZajNW9m' },
  'ismael mora':          { id:'1o8ofJXnQHAt8hsjfVzXkGLkcSZajNW9m', url:'https://drive.google.com/drive/folders/1o8ofJXnQHAt8hsjfVzXkGLkcSZajNW9m' },
  'josue ramos':          { id:'1SncZZLAp1wUISjZfWKT2W0_gn12xeE_F', url:'https://drive.google.com/drive/folders/1SncZZLAp1wUISjZfWKT2W0_gn12xeE_F' },
  'josh ramos':           { id:'1SncZZLAp1wUISjZfWKT2W0_gn12xeE_F', url:'https://drive.google.com/drive/folders/1SncZZLAp1wUISjZfWKT2W0_gn12xeE_F' },
  'karina beltran buyer': { id:'1__ncO_lYLMx_juBnVzJ84amC3b8oEHfG', url:'https://drive.google.com/drive/folders/1__ncO_lYLMx_juBnVzJ84amC3b8oEHfG' },
  'karina beltran':       { id:'1__ncO_lYLMx_juBnVzJ84amC3b8oEHfG', url:'https://drive.google.com/drive/folders/1__ncO_lYLMx_juBnVzJ84amC3b8oEHfG' },
  'isabel heloc':         { id:'10zo3q4Z549hCGTPfFcyeFQjFo_SYADg9', url:'https://drive.google.com/drive/folders/10zo3q4Z549hCGTPfFcyeFQjFo_SYADg9' },
  'manny nieto refi':     { id:'1eM6MLvO8nWpQRhgMDrTdVRNcsGoe9DAW', url:'https://drive.google.com/drive/folders/1eM6MLvO8nWpQRhgMDrTdVRNcsGoe9DAW' },
  'manny nieto':          { id:'1eM6MLvO8nWpQRhgMDrTdVRNcsGoe9DAW', url:'https://drive.google.com/drive/folders/1eM6MLvO8nWpQRhgMDrTdVRNcsGoe9DAW' },
  'bridge deal jesse':    { id:'1eG1FrPNfn2pnadwu8P7UC4WD71wz8rQf', url:'https://drive.google.com/drive/folders/1eG1FrPNfn2pnadwu8P7UC4WD71wz8rQf' },
  'jesse':                { id:'1eG1FrPNfn2pnadwu8P7UC4WD71wz8rQf', url:'https://drive.google.com/drive/folders/1eG1FrPNfn2pnadwu8P7UC4WD71wz8rQf' },
};

function normalize(s: string) { return s.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim(); }

function searchKnownFolders(firstName: string, lastName: string): {id:string,url:string,name:string}|null {
  const full = normalize(`${firstName} ${lastName}`);
  const first = normalize(firstName);
  const last = normalize(lastName);
  
  // Exact full name match first
  for (const [key, val] of Object.entries(KNOWN_BORROWER_FOLDERS)) {
    if (key === full) return { ...val, name: key };
  }
  // Partial: last name + first name in any folder key
  for (const [key, val] of Object.entries(KNOWN_BORROWER_FOLDERS)) {
    if (key.includes(last) && key.includes(first)) return { ...val, name: key };
    if (key.includes(last)) return { ...val, name: key };
  }
  return null;
}

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

  // 2. Search known existing folders by name
  const fn = first_name || '';
  const ln = last_name || '';
  const match = searchKnownFolders(fn, ln);

  if (match) {
    // Found existing folder — link it to contact if we have the ID
    if (contact_id && auto_save) {
      await sb.from('contacts').update({
        gdrive_folder_id: match.id,
        gdrive_folder_url: match.url,
        gdrive_folder_name: match.name
      }).eq('id', contact_id);
    }
    return new Response(JSON.stringify({
      success: true,
      found: true,
      already_linked: false,
      folder_id: match.id,
      folder_url: match.url,
      folder_name: match.name,
      drive_root: `${GDRIVE_BASE}${GDRIVE_BORROWERS_ROOT}`,
      message: `Found existing Drive folder: "${match.name}"`
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

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
async function searchBorrowerFolder(body: any) {
  const { first_name, last_name } = body;
  const match = searchKnownFolders(first_name || '', last_name || '');
  
  if (match) {
    return new Response(JSON.stringify({
      success: true, found: true,
      folder_id: match.id, folder_url: match.url, folder_name: match.name
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // Return all known folders for manual matching
  const allFolders = Object.entries(KNOWN_BORROWER_FOLDERS).map(([name, info]) => ({
    name, folder_id: info.id, folder_url: info.url
  }));
  // Deduplicate by folder_id
  const seen = new Set();
  const unique = allFolders.filter(f => { if (seen.has(f.folder_id)) return false; seen.add(f.folder_id); return true; });

  return new Response(JSON.stringify({
    success: true, found: false,
    message: 'No matching folder found',
    all_known_folders: unique
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
    known_borrower_folders: Object.keys(KNOWN_BORROWER_FOLDERS).length
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}
