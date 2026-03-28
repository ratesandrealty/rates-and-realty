import { DOCUMENT_BUCKET } from "/api/config.js";
import { supabase } from "/api/supabase-client.js";

export async function getBorrowerDashboard(userId) {
  const [profileResult, applicationResult, documentsResult] = await Promise.all([
    supabase.from("borrower_profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("mortgage_applications").select("*").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("uploaded_documents").select("*").eq("user_id", userId).order("created_at", { ascending: false })
  ]);

  if (profileResult.error) throw profileResult.error;
  if (applicationResult.error) throw applicationResult.error;
  if (documentsResult.error) throw documentsResult.error;

  return {
    profile: profileResult.data,
    application: applicationResult.data,
    documents: documentsResult.data || []
  };
}

export async function saveApplication(user, payload) {
  // Keep the full multi-step form payload in one application JSON field while also syncing core reporting columns.
  const { error: profileError } = await supabase.from("borrower_profiles").upsert({
    user_id: user.id,
    first_name: payload.borrowerFirstName,
    last_name: payload.borrowerLastName,
    phone: payload.borrowerPhone,
    date_of_birth: payload.dateOfBirth || null,
    current_address: payload.currentAddress || null,
    email: user.email
  }, { onConflict: "user_id" });

  if (profileError) throw profileError;

  const { data: application, error: applicationError } = await supabase
    .from("mortgage_applications")
    .upsert({
      user_id: user.id,
      status: payload.applicationStatus || "draft",
      loan_type: payload.loanType || "Conventional",
      property_address: payload.propertyAddress || null,
      purchase_price: numberOrNull(payload.purchasePrice),
      loan_amount: numberOrNull(payload.loanAmount),
      application_data: payload,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" })
    .select()
    .single();

  if (applicationError) throw applicationError;

  await Promise.all([
    supabase.from("application_borrowers").upsert({
      application_id: application.id,
      user_id: user.id,
      borrower_role: "primary",
      first_name: payload.borrowerFirstName,
      last_name: payload.borrowerLastName,
      email: user.email,
      phone: payload.borrowerPhone || null
    }, { onConflict: "application_id,user_id" }),
    supabase.from("employment_records").upsert({
      application_id: application.id,
      user_id: user.id,
      employer_name: payload.employerName || null,
      job_title: payload.jobTitle || null,
      monthly_income: numberOrNull(payload.monthlyIncome),
      years_on_job: numberOrNull(payload.yearsOnJob)
    }, { onConflict: "application_id,user_id" }),
    supabase.from("assets").upsert([
      { application_id: application.id, user_id: user.id, asset_type: "cash", amount: numberOrNull(payload.cashAssets) },
      { application_id: application.id, user_id: user.id, asset_type: "investments", amount: numberOrNull(payload.investmentAssets) }
    ], { onConflict: "application_id,user_id,asset_type" }),
    supabase.from("liabilities").upsert([
      { application_id: application.id, user_id: user.id, liability_type: "monthly_debt", amount: numberOrNull(payload.monthlyDebt) },
      { application_id: application.id, user_id: user.id, liability_type: "other", amount: numberOrNull(payload.otherLiabilities) }
    ], { onConflict: "application_id,user_id,liability_type" })
  ]);

  return application;
}

export async function uploadBorrowerDocument({ userId, applicationId, file }) {
  const sanitizedName = `${Date.now()}-${file.name.replace(/\s+/g, "-")}`;
  const storagePath = `${userId}/${sanitizedName}`;

  const { error: uploadError } = await supabase.storage.from(DOCUMENT_BUCKET).upload(storagePath, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase.from("uploaded_documents").insert({
    application_id: applicationId,
    user_id: userId,
    file_name: file.name,
    file_path: storagePath,
    bucket_name: DOCUMENT_BUCKET,
    mime_type: file.type,
    status: "uploaded"
  }).select().single();

  if (error) throw error;
  return data;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && value !== "" ? number : null;
}
