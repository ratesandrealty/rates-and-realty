import { createLeadCapture } from "/api/public-api.js";
import { formToObject, setMessage } from "/components/ui.js";

const form = document.getElementById("funnel-form");
const message = document.getElementById("funnel-message");
const thankYouState = document.getElementById("thank-you-state");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(message, "Submitting...");

  const payload = formToObject(form);
  const funnelTag = document.body.dataset.funnelSource || "public_funnel";

  try {
    await createLeadCapture({
      ...payload,
      source: funnelTag,
      funnelTag
    });

    setMessage(message, "Lead captured.", "success");
    form.classList.add("hidden");
    thankYouState?.classList.remove("hidden");
  } catch (error) {
    setMessage(message, error.message || "Unable to submit form.", "error");
  }
});
