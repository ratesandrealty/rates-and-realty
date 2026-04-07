const listings = [
  { title: "Sunset Hills Residence", city: "Los Angeles", price: 1450000, beds: 4, baths: 3, propertyType: "Single Family", keyword: "view modern", image: "/public/images/hero-estate.svg" },
  { title: "Harbor Loft Collection", city: "Long Beach", price: 835000, beds: 2, baths: 2, propertyType: "Condo", keyword: "turnkey luxury", image: "/public/images/card-conventional.svg" },
  { title: "Palm Terrace Townhome", city: "Irvine", price: 990000, beds: 3, baths: 3, propertyType: "Townhome", keyword: "gated new build", image: "/public/images/card-fha.svg" },
  { title: "Oak Crest Duplex", city: "San Diego", price: 1250000, beds: 4, baths: 4, propertyType: "Multi Family", keyword: "investor income", image: "/public/images/card-dscr.svg" },
  { title: "Bel Air View Estate", city: "Los Angeles", price: 2850000, beds: 5, baths: 5, propertyType: "Single Family", keyword: "pool city view", image: "/public/images/hero-estate.svg" },
  { title: "Downtown Luxe Condo", city: "San Francisco", price: 1180000, beds: 2, baths: 2, propertyType: "Condo", keyword: "urban concierge", image: "/public/images/card-conventional.svg" }
];

const form = document.getElementById("property-search-form");
const results = document.getElementById("listing-results");
const resetButton = document.getElementById("reset-search-button");

function render(items) {
  results.innerHTML = items.map((item) => `
    <article class="panel listing-card">
      <img src="${item.image}" alt="${item.title}">
      <div class="listing-copy">
        <span class="eyebrow-chip">${item.propertyType}</span>
        <h3>${item.title}</h3>
        <div class="listing-meta">
          <span>${item.city}</span>
          <span>${item.beds} Beds</span>
          <span>${item.baths} Baths</span>
        </div>
        <p class="section-copy">$${item.price.toLocaleString()}</p>
        <a class="text-link" href="/public/apply.html">Request Financing Options</a>
      </div>
    </article>
  `).join("");
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const minPrice = Number(data.minPrice || 0);
  const maxPrice = Number(data.maxPrice || Number.MAX_SAFE_INTEGER);
  const beds = Number(data.beds || 0);
  const baths = Number(data.baths || 0);
  const keyword = String(data.keyword || "").toLowerCase();
  const city = String(data.city || "").toLowerCase();
  const propertyType = String(data.propertyType || "");

  const filtered = listings.filter((item) => {
    return item.price >= minPrice
      && item.price <= maxPrice
      && item.beds >= beds
      && item.baths >= baths
      && (!city || item.city.toLowerCase().includes(city))
      && (!propertyType || item.propertyType === propertyType)
      && (!keyword || `${item.title} ${item.keyword}`.toLowerCase().includes(keyword));
  });

  render(filtered);
});

resetButton?.addEventListener("click", () => {
  form.reset();
  render(listings);
});

// Pre-populate from URL params (listing alert deep links)
const _urlParams = new URLSearchParams(window.location.search);
if (_urlParams.toString()) {
  const _city = _urlParams.get('cities') || _urlParams.get('city') || '';
  const _minPrice = _urlParams.get('min_price') || '';
  const _maxPrice = _urlParams.get('max_price') || '';
  const _beds = _urlParams.get('min_beds') || _urlParams.get('beds') || '';
  const _baths = _urlParams.get('min_baths') || _urlParams.get('baths') || '';
  const _propType = _urlParams.get('property_types') || '';

  const cityInput = form?.querySelector('[name="city"]');
  const minPriceInput = form?.querySelector('[name="minPrice"]');
  const maxPriceInput = form?.querySelector('[name="maxPrice"]');
  const bedsSelect = form?.querySelector('[name="beds"]');
  const bathsSelect = form?.querySelector('[name="baths"]');
  const propTypeSelect = form?.querySelector('[name="propertyType"]');

  if (cityInput && _city) cityInput.value = _city.split(',')[0];
  if (minPriceInput && _minPrice) minPriceInput.value = _minPrice;
  if (maxPriceInput && _maxPrice) maxPriceInput.value = _maxPrice;
  if (bedsSelect && _beds) bedsSelect.value = _beds;
  if (bathsSelect && _baths) bathsSelect.value = _baths;
  if (propTypeSelect && _propType) propTypeSelect.value = _propType.split(',')[0];

  // Store highlight key if provided
  if (_urlParams.get('highlight')) {
    window._highlightListingKey = _urlParams.get('highlight');
  }

  // Auto-submit the search
  setTimeout(() => { form?.dispatchEvent(new Event('submit', { cancelable: true })); }, 100);
} else {
  render(listings);
}
