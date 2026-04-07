const PROXY_URL = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/trestle-proxy';
const form = document.getElementById("property-search-form");
const results = document.getElementById("listing-results");
const resetButton = document.getElementById("reset-search-button");
const heading = document.getElementById("results-heading");

function proxyPhoto(mediaUrl) {
  return PROXY_URL + '?photo=' + encodeURIComponent(mediaUrl);
}

function getPrimaryPhoto(listing) {
  if (!listing.Media || !listing.Media.length) return '/public/images/hero-estate.svg';
  const sorted = [...listing.Media].sort((a, b) => (a.Order || 0) - (b.Order || 0));
  return proxyPhoto(sorted[0].MediaURL);
}

function formatPrice(price) {
  return '$' + Number(price).toLocaleString();
}

function renderListings(items) {
  if (!items.length) {
    results.innerHTML = '<p class="section-copy" style="grid-column:1/-1;text-align:center;padding:40px 0;">No listings found. Try adjusting your filters.</p>';
    heading.textContent = 'No Results';
    return;
  }
  heading.textContent = `${items.length} Listing${items.length !== 1 ? 's' : ''}`;
  results.innerHTML = items.map((item) => {
    const addr = item.UnparsedAddress || 'Address Unavailable';
    const city = item.City || '';
    const state = item.StateOrProvince || '';
    const zip = item.PostalCode || '';
    const location = [city, state].filter(Boolean).join(', ') + (zip ? ' ' + zip : '');
    const beds = item.BedroomsTotal ?? '–';
    const baths = item.BathroomsTotalInteger ?? '–';
    const sqft = item.LivingArea ? item.LivingArea.toLocaleString() + ' sqft' : '';
    const imgSrc = getPrimaryPhoto(item);
    return `
    <article class="panel listing-card" data-listing-key="${item.ListingKey}">
      <img src="${imgSrc}" alt="${addr}" loading="lazy" onerror="this.src='/public/images/hero-estate.svg'">
      <div class="listing-copy">
        <span class="eyebrow-chip">${item.StandardStatus || 'Active'}</span>
        <h3>${addr}</h3>
        <div class="listing-meta">
          <span>${location}</span>
          <span>${beds} Beds</span>
          <span>${baths} Baths</span>
          ${sqft ? `<span>${sqft}</span>` : ''}
        </div>
        <p class="section-copy">${formatPrice(item.ListPrice)}</p>
        <a class="text-link" href="/public/apply.html">Request Financing Options</a>
      </div>
    </article>`;
  }).join("");

  // Highlight if needed
  if (window._highlightListingKey) {
    const card = results.querySelector(`[data-listing-key="${window._highlightListingKey}"]`);
    if (card) {
      card.style.outline = '3px solid #c9a84c';
      card.style.outlineOffset = '2px';
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function showLoading() {
  results.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 0;">
    <div style="display:inline-block;width:36px;height:36px;border:3px solid #333;border-top-color:#c9a84c;border-radius:50%;animation:spin .8s linear infinite;"></div>
    <p class="section-copy" style="margin-top:12px;">Loading listings&hellip;</p>
  </div>`;
  heading.textContent = 'Searching…';
}

function showError(msg) {
  results.innerHTML = `<p class="section-copy" style="grid-column:1/-1;text-align:center;padding:40px 0;color:#e57373;">Error loading listings: ${msg}. Please try again.</p>`;
  heading.textContent = 'Error';
}

// Map user-facing property types to OData PropertyType values
function mapPropertyType(type) {
  switch (type) {
    case 'Single Family': case 'Condo': case 'Townhouse': return 'Residential';
    case 'Multi-Family': return 'ResidentialIncome';
    case 'Land': return 'Land';
    default: return '';
  }
}

function buildFilter(params) {
  const parts = [];

  // Cities
  const cities = params.cities || params.city || '';
  if (cities) {
    const cityList = cities.split(',').map(c => c.trim()).filter(Boolean);
    if (cityList.length === 1) parts.push(`City eq '${cityList[0]}'`);
    else if (cityList.length > 1) parts.push('(' + cityList.map(c => `City eq '${c}'`).join(' or ') + ')');
  }

  // Statuses
  const statuses = params.statuses || params.status || '';
  if (statuses) {
    const statusList = statuses.split(',').map(s => s.trim()).filter(Boolean);
    if (statusList.length === 1) parts.push(`StandardStatus eq '${statusList[0]}'`);
    else if (statusList.length > 1) parts.push('(' + statusList.map(s => `StandardStatus eq '${s}'`).join(' or ') + ')');
  } else {
    parts.push("StandardStatus eq 'Active'");
  }

  // Property types
  const propTypes = params.property_types || params.propertyType || '';
  if (propTypes) {
    const typeList = propTypes.split(',').map(t => t.trim()).filter(Boolean);
    const mapped = [...new Set(typeList.map(mapPropertyType).filter(Boolean))];
    if (mapped.length === 1) parts.push(`PropertyType eq '${mapped[0]}'`);
    else if (mapped.length > 1) parts.push('(' + mapped.map(t => `PropertyType eq '${t}'`).join(' or ') + ')');
  } else {
    parts.push("PropertyType eq 'Residential'");
  }

  // Price
  const minPrice = Number(params.min_price || params.minPrice || 0);
  const maxPrice = Number(params.max_price || params.maxPrice || 0);
  if (minPrice > 0) parts.push(`ListPrice ge ${minPrice}`);
  if (maxPrice > 0) parts.push(`ListPrice le ${maxPrice}`);

  // Beds / Baths
  const minBeds = Number(params.min_beds || params.beds || 0);
  const minBaths = Number(params.min_baths || params.baths || 0);
  if (minBeds > 0) parts.push(`BedroomsTotal ge ${minBeds}`);
  if (minBaths > 0) parts.push(`BathroomsTotalInteger ge ${minBaths}`);

  // Sqft
  const minSqft = Number(params.min_sqft || params.minSqft || 0);
  const maxSqft = Number(params.max_sqft || params.maxSqft || 0);
  if (minSqft > 0) parts.push(`LivingArea ge ${minSqft}`);
  if (maxSqft > 0) parts.push(`LivingArea le ${maxSqft}`);

  // Pool
  if (params.has_pool === 'true') parts.push('PoolPrivateYN eq true');

  return parts.join(' and ');
}

async function fetchListings(params) {
  showLoading();
  const filter = buildFilter(params);
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': window.APP_CONFIG.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        endpoint: 'Property',
        params: {
          '$filter': filter,
          '$top': '25',
          '$orderby': 'ModificationTimestamp desc',
          '$expand': 'Media',
          '$select': 'ListingKey,ListPrice,BedroomsTotal,BathroomsTotalInteger,LivingArea,UnparsedAddress,City,StateOrProvince,PostalCode,PublicRemarks,Media,StandardStatus'
        }
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderListings(data.value || []);
  } catch (err) {
    console.error('Listing fetch error:', err);
    showError(err.message);
  }
}

function getFormParams() {
  const fd = Object.fromEntries(new FormData(form).entries());
  return {
    city: fd.city || '',
    minPrice: fd.minPrice || '',
    maxPrice: fd.maxPrice || '',
    beds: fd.beds || '',
    baths: fd.baths || '',
    propertyType: fd.propertyType || '',
    status: fd.status || '',
    minSqft: fd.minSqft || '',
    maxSqft: fd.maxSqft || ''
  };
}

// Form submit
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  fetchListings(getFormParams());
});

// Reset
resetButton?.addEventListener("click", () => {
  form.reset();
  fetchListings({});
});

// Add spinner animation
const style = document.createElement('style');
style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(style);

// URL params from listing alert emails
const _urlParams = new URLSearchParams(window.location.search);
if (_urlParams.toString()) {
  const params = {};
  for (const [k, v] of _urlParams.entries()) params[k] = v;

  // Pre-fill form inputs
  const cityInput = form?.querySelector('[name="city"]');
  const minPriceInput = form?.querySelector('[name="minPrice"]');
  const maxPriceInput = form?.querySelector('[name="maxPrice"]');
  const bedsSelect = form?.querySelector('[name="beds"]');
  const bathsSelect = form?.querySelector('[name="baths"]');
  const propTypeSelect = form?.querySelector('[name="propertyType"]');
  const statusSelect = form?.querySelector('[name="status"]');
  const minSqftInput = form?.querySelector('[name="minSqft"]');
  const maxSqftInput = form?.querySelector('[name="maxSqft"]');

  const city = params.cities || params.city || '';
  if (cityInput && city) cityInput.value = city.split(',')[0];
  if (minPriceInput && params.min_price) minPriceInput.value = params.min_price;
  if (maxPriceInput && params.max_price) maxPriceInput.value = params.max_price;
  if (bedsSelect && params.min_beds) bedsSelect.value = params.min_beds;
  if (bathsSelect && params.min_baths) bathsSelect.value = params.min_baths;
  if (propTypeSelect && params.property_types) propTypeSelect.value = params.property_types.split(',')[0];
  if (statusSelect && params.statuses) statusSelect.value = params.statuses.split(',')[0];
  if (minSqftInput && params.min_sqft) minSqftInput.value = params.min_sqft;
  if (maxSqftInput && params.max_sqft) maxSqftInput.value = params.max_sqft;

  // Store highlight key
  if (params.highlight) window._highlightListingKey = params.highlight;

  // Fetch with URL params
  fetchListings(params);
} else {
  // Default load
  fetchListings({});
}
