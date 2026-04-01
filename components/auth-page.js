import { signInBorrower, signUpBorrower, isAdminUser } from "/api/auth-api.js";
import { formToObject, setMessage } from "/components/ui.js";

const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const loginMessage = document.getElementById("login-message");
const signupMessage = document.getElementById("signup-message");
const tabButtons = document.querySelectorAll("[data-auth-tab]");

function switchTab(tabName) {
  tabButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.authTab === tabName));
  loginForm.classList.toggle("is-hidden", tabName !== "login");
  signupForm.classList.toggle("is-hidden", tabName !== "signup");
}

tabButtons.forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.authTab)));

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(loginMessage, "Signing in...");
  try {
    const result = await signInBorrower(formToObject(loginForm));
    setMessage(loginMessage, "Signed in. Redirecting...", "success");
    const user = result?.user || result?.data?.user;
    if (user && isAdminUser(user)) {
      window.location.href = "/dashboard/admin.html";
    } else {
      window.location.href = "/public/unified-portal.html";
    }
  } catch (error) {
    setMessage(loginMessage, error.message || "Unable to sign in.", "error");
  }
});

signupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(signupMessage, "Creating account...");
  try {
    await signUpBorrower(formToObject(signupForm));
    setMessage(signupMessage, "Account created. Check email confirmation if enabled, then sign in.", "success");
    switchTab("login");
  } catch (error) {
    setMessage(signupMessage, error.message || "Unable to create account.", "error");
  }
});
