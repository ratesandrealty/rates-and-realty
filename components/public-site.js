import { createLeadCapture } from "/api/public-api.js";
import { formToObject, getQueryParam, setMessage } from "/components/ui.js";

const leadForm = document.getElementById("lead-form");
const leadMessage = document.getElementById("lead-form-message");

if (leadForm) {
  const loanType = getQueryParam("loanType");
  if (loanType && leadForm.elements.loanType) leadForm.elements.loanType.value = loanType;

  leadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(leadMessage, "Submitting lead...");

    try {
      await createLeadCapture({
        ...formToObject(leadForm),
        source: "website_apply",
        funnelTag: "general_apply"
      });
      setMessage(leadMessage, "Lead captured. Redirecting to the borrower portal.", "success");
      leadForm.reset();
      window.setTimeout(() => {
        window.location.href = "/public/unified-portal.html";
      }, 1200);
    } catch (error) {
      setMessage(leadMessage, error.message || "Unable to submit lead.", "error");
    }
  });
}
