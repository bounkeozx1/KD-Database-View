'use strict';
/**
 * infra/ai.js — AI document extraction via Google Gemini.
 *
 * Enable by setting an environment variable before launch:
 *     GEMINI_API_KEY=xxxxxxxx   (optional: GEMINI_MODEL=gemini-1.5-flash)
 *
 * Without a key, extract() returns { ok:false, mock:true } so the front-end
 * keeps working (it just attaches the file and skips auto-fill). The exact
 * prompts the model receives live here — edit them in one place.
 *
 * Zero npm deps: uses Node's built-in global fetch (Node 18+).
 */

/* ── Prompts (one per document type) ──────────────────────────────── */

const PASSPORT_PROMPT = `You are a professional passport OCR and document extraction system.

Analyze the uploaded passport image and extract all visible passport information.

Rules:

* Return ONLY valid JSON.
* Do NOT include explanations.
* Do NOT include markdown.
* Do NOT guess missing values.
* If a field cannot be found, use an empty string.
* Use the MRZ (Machine Readable Zone) if available to verify the data.
* Dates must be returned in YYYY-MM-DD format.

Return this exact structure:

{
"passport_number": "",
"surname": "",
"given_names": "",
"full_name": "",
"nationality": "",
"country_code": "",
"date_of_birth": "",
"place_of_birth": "",
"sex": "",
"date_of_issue": "",
"expiry_date": "",
"issuing_authority": "",
"personal_number": "",
"mrz_line_1": "",
"mrz_line_2": "",
"confidence_notes": ""
}

Extract data from the passport image now.`;

const ID_CARD_PROMPT = `You are a professional national ID-card OCR and document extraction system.

Analyze the uploaded ID-card image and extract all visible information.

Rules:

* Return ONLY valid JSON.
* Do NOT include explanations.
* Do NOT include markdown.
* Do NOT guess missing values.
* If a field cannot be found, use an empty string.
* Dates must be returned in YYYY-MM-DD format.

Return this exact structure:

{
"id_number": "",
"full_name": "",
"full_name_local": "",
"date_of_birth": "",
"sex": "",
"nationality": "",
"address": "",
"date_of_issue": "",
"expiry_date": "",
"issuing_authority": "",
"confidence_notes": ""
}

Extract data from the ID-card image now.`;

const LAND_DOC_PROMPT = `You are a professional land-title (land deed) OCR and document extraction system.

Analyze the uploaded land document image and extract all visible information.

Rules:

* Return ONLY valid JSON.
* Do NOT include explanations.
* Do NOT include markdown.
* Do NOT guess missing values.
* If a field cannot be found, use an empty string.
* Dates must be returned in YYYY-MM-DD format.

Return this exact structure:

{
"document_number": "",
"owner_name": "",
"parcel_number": "",
"area": "",
"location": "",
"issue_date": "",
"issuing_authority": "",
"confidence_notes": ""
}

Extract data from the land document image now.`;

const FORM_PROMPT = `You are a professional application-form OCR and document extraction system for a labour-recruitment worker intake form.

Analyze the uploaded form image and extract all visible worker information.

Rules:

* Return ONLY valid JSON.
* Do NOT include explanations.
* Do NOT include markdown.
* Do NOT guess missing values.
* If a field cannot be found, use an empty string.
* Dates must be returned in YYYY-MM-DD format.

Return this exact structure:

{
"full_name_en": "",
"full_name_local": "",
"date_of_birth": "",
"sex": "",
"nationality": "",
"passport_number": "",
"address": "",
"village": "",
"district": "",
"province": "",
"tel": "",
"emergency_tel": "",
"education": "",
"confidence_notes": ""
}

Extract data from the form image now.`;

const PROMPTS = {
  passport: PASSPORT_PROMPT,
  id_card:  ID_CARD_PROMPT,
  land_doc: LAND_DOC_PROMPT,
  form_1:   FORM_PROMPT,
};

const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

/* ── Extraction ───────────────────────────────────────────────────── */

async function extract(imageDataUrl, docType) {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return { ok: false, mock: true, reason: 'no-api-key' };

  const m = /^data:([^;]+);base64,(.*)$/.exec(imageDataUrl || '');
  if (!m) return { ok: false, error: 'bad-image' };

  const prompt = PROMPTS[docType] || PASSPORT_PROMPT;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(MODEL) + ':generateContent?key=' + encodeURIComponent(key);
  const payload = {
    contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: m[1], data: m[2] } } ] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + res.status) };
    const text = (((j.candidates || [])[0] || {}).content || {}).parts &&
                 j.candidates[0].content.parts[0].text || '';
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* model returned non-JSON */ }
    return { ok: !!data, data, raw: text };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { extract, PROMPTS };
