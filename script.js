// Cache all interactive and output elements once so the calculator logic stays simple.
const form = document.getElementById("quote-form");
const resetButton = document.getElementById("reset-button");
const errorMessage = document.getElementById("error-message");

const fields = {
  propertyValue: document.getElementById("propertyValue"),
  loanAmount: document.getElementById("loanAmount"),
  monthlyRent: document.getElementById("monthlyRent"),
  interestRate: document.getElementById("interestRate"),
  loanTerm: document.getElementById("loanTerm"),
  annualTaxes: document.getElementById("annualTaxes"),
  annualInsurance: document.getElementById("annualInsurance")
};

const outputs = {
  monthlyPI: document.getElementById("monthlyPI"),
  monthlyHousing: document.getElementById("monthlyHousing"),
  dscrRatio: document.getElementById("dscrRatio"),
  cashFlow: document.getElementById("cashFlow"),
  monthlyTaxes: document.getElementById("monthlyTaxes"),
  monthlyInsurance: document.getElementById("monthlyInsurance")
};

// Format any numeric value as US currency for easy reading.
function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(value);
}

// Basic numeric parser used by validation and the calculator.
function getNumericValue(input) {
  return Number.parseFloat(input.value);
}

// Validate required fields and obvious business rule issues before calculating.
function validateInputs(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value < 0) {
      return `Please enter a valid non-negative number for ${labelFromKey(key)}.`;
    }
  }

  if (values.loanTerm <= 0) {
    return "Loan term must be greater than zero.";
  }

  if (values.propertyValue === 0) {
    return "Property value must be greater than zero.";
  }

  if (values.loanAmount > values.propertyValue) {
    return "Loan amount cannot exceed property value.";
  }

  return "";
}

// Convert object keys into readable field labels for error messages.
function labelFromKey(key) {
  const labels = {
    propertyValue: "property value",
    loanAmount: "loan amount",
    monthlyRent: "monthly rent",
    interestRate: "interest rate",
    loanTerm: "loan term",
    annualTaxes: "annual taxes",
    annualInsurance: "annual insurance"
  };

  return labels[key] || key;
}

// Standard amortization formula for fixed-rate principal and interest payments.
function calculateMonthlyPI(loanAmount, annualRate, loanTermYears) {
  const monthlyRate = annualRate / 100 / 12;
  const totalPayments = loanTermYears * 12;

  if (monthlyRate === 0) {
    return loanAmount / totalPayments;
  }

  const factor = Math.pow(1 + monthlyRate, totalPayments);
  return loanAmount * ((monthlyRate * factor) / (factor - 1));
}

// Write all results to the UI and apply cash-flow color cues.
function updateResults(results) {
  outputs.monthlyPI.textContent = formatCurrency(results.monthlyPI);
  outputs.monthlyHousing.textContent = formatCurrency(results.monthlyHousing);
  outputs.dscrRatio.textContent = `${results.dscr.toFixed(2)}x`;
  outputs.cashFlow.textContent = formatCurrency(results.cashFlow);
  outputs.monthlyTaxes.textContent = formatCurrency(results.monthlyTaxes);
  outputs.monthlyInsurance.textContent = formatCurrency(results.monthlyInsurance);

  outputs.cashFlow.classList.remove("positive", "negative");
  outputs.cashFlow.classList.add(results.cashFlow >= 0 ? "positive" : "negative");
}

// Reset the quote panel back to a neutral starting state.
function resetResults() {
  updateResults({
    monthlyPI: 0,
    monthlyHousing: 0,
    dscr: 0,
    cashFlow: 0,
    monthlyTaxes: 0,
    monthlyInsurance: 0
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const values = Object.fromEntries(
    Object.entries(fields).map(([key, input]) => [key, getNumericValue(input)])
  );

  const validationError = validateInputs(values);
  errorMessage.textContent = validationError;

  if (validationError) {
    return;
  }

  const monthlyTaxes = values.annualTaxes / 12;
  const monthlyInsurance = values.annualInsurance / 12;
  const monthlyPI = calculateMonthlyPI(values.loanAmount, values.interestRate, values.loanTerm);
  const monthlyHousing = monthlyPI + monthlyTaxes + monthlyInsurance;
  const dscr = monthlyHousing === 0 ? 0 : values.monthlyRent / monthlyHousing;
  const cashFlow = values.monthlyRent - monthlyHousing;

  updateResults({
    monthlyPI,
    monthlyHousing,
    dscr,
    cashFlow,
    monthlyTaxes,
    monthlyInsurance
  });
});

resetButton.addEventListener("click", () => {
  form.reset();
  errorMessage.textContent = "";
  resetResults();
});

// Load the page with zeroed values so the layout looks complete before input.
resetResults();
