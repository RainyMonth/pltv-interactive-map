const DATA_URL = "data/voting.json";
const BOUNDARY_URL = "data/ward27_divisions.geojson";
const PALETTES = {
  registration: ["#c6dcf3", "#9bbce2", "#7199ce", "#4774b3", "#285394", "#123675", "#011f5b"],
  votes: ["#d1e5d8", "#a5cdb5", "#76b18e", "#479568", "#26774e", "#105b3b", "#03442d"],
  turnout: ["#fff5d6", "#ffd985", "#f7ae52", "#ef7d3c", "#d94b3d", "#9f2842", "#61123b"],
};
// Control points increase contrast at high turnout while retaining a continuous legend.
const GENERAL_TURNOUT_STOPS = [0.4, 0.55, 0.7, 0.8, 0.85, 0.9, 1];

const numberFormat = new Intl.NumberFormat("en-US");
const state = {
  records: [],
  boundaries: null,
  electionType: "Primary",
  year: null,
  registrationWindow: 4,
  maps: [],
  syncing: false,
};

const elements = {
  electionOptions: document.querySelector("#election-options"),
  electionValue: document.querySelector("#election-value"),
  yearSlider: document.querySelector("#year-slider"),
  yearValue: document.querySelector("#year-value"),
  yearTicks: document.querySelector("#year-ticks"),
  snapshotTitle: document.querySelector("#snapshot-title"),
  totalVotes: document.querySelector("#total-votes"),
  totalRegistration: document.querySelector("#total-registration"),
  oneYearRegistration: document.querySelector("#one-year-registration"),
  totalTurnout: document.querySelector("#total-turnout"),
  loadingState: document.querySelector("#loading-state"),
  errorState: document.querySelector("#error-state"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function availableTypes() {
  const order = ["Primary", "General"];
  const found = new Set(state.records.map((record) => record.electionType));
  return order.filter((type) => found.has(type));
}

function availableYears(electionType = state.electionType) {
  return [...new Set(
    state.records
      .filter((record) => record.electionType === electionType)
      .map((record) => record.year),
  )].sort((a, b) => a - b);
}

function selectedRecords() {
  return state.records.filter(
    (record) => record.electionType === state.electionType && record.year === state.year,
  );
}

function niceStep(rawStep) {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(rawStep, 1)));
  const fraction = rawStep / exponent;
  const niceFraction = [1, 2, 4, 5, 10].find((candidate) => candidate >= fraction) ?? 10;
  return niceFraction * exponent;
}

function metricField(metric) {
  if (metric === "registration") return state.registrationWindow === 1 ? "oneYearRegistrationNumber" : "registrationNumber";
  return metric === "votes" ? "voteCount" : "turnoutRate";
}

function metricTitle(metric) {
  if (metric === "registration") return `${state.registrationWindow} ${state.registrationWindow === 1 ? "Year" : "Years"} Registration`;
  return metric === "votes" ? "Vote Count" : "Turnout Rate";
}

function formatMetric(value, metric) {
  if (!Number.isFinite(value)) return "No data";
  return metric === "turnout" ? `${(value * 100).toFixed(1)}%` : numberFormat.format(value);
}

// Each election type uses one range across ALL available years.
function metricScale(metric) {
  if (metric === "turnout" && state.electionType === "General") return { minimum: 0.4, maximum: 1, ticks: [0.4, 0.6, 0.8, 1], stops: GENERAL_TURNOUT_STOPS };
  if (metric === "turnout") {
    const values = state.records.filter(r => r.electionType === state.electionType && Number.isFinite(r.turnoutRate)).map(r => r.turnoutRate);
    const step = state.electionType === "Primary" ? 0.05 : 0.1;
    const minimum = values.length ? Math.max(0, Math.floor((Math.min(...values) + 1e-10) / step) * step) : 0;
    const maximum = values.length ? Math.min(1, Math.max(minimum + step, Math.ceil((Math.max(...values) - 1e-10) / step) * step)) : 1;
    const ticks = [];
    for (let value = minimum; value <= maximum + 1e-10; value += step) ticks.push(Number(value.toFixed(4)));
    return { minimum, maximum, ticks: state.electionType === "General" ? ticks.filter((_, i) => i % 2 === 0 || i === ticks.length - 1) : ticks };
  }
  const field = metricField(metric);
  const max = Math.max(1, ...state.records.filter(r => r.electionType === state.electionType).map(r => r[field]));
  const step = niceStep(max / 4);
  const maximum = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= maximum; value += step) ticks.push(value);
  return { minimum: 0, maximum, ticks };
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function interpolateColor(startHex, endHex, amount) {
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  const channel = (key) => Math.round(start[key] + (end[key] - start[key]) * amount);
  return `rgb(${channel("r")}, ${channel("g")}, ${channel("b")})`;
}

function colorFor(value, scale, metric) {
  if (!Number.isFinite(value)) return "#b7c3ca";
  const colors = PALETTES[metric];
  if (scale.stops) {
    const v = Math.max(scale.minimum, Math.min(scale.maximum, value));
    const i = Math.min(colors.length - 2, scale.stops.findLastIndex(stop => v >= stop));
    const amount = (v - scale.stops[i]) / (scale.stops[i + 1] - scale.stops[i]);
    return interpolateColor(colors[i], colors[i + 1], amount);
  }
  const ratio = Math.max(0, Math.min(1, (value - scale.minimum) / Math.max(scale.maximum - scale.minimum, Number.EPSILON)));
  const scaled = ratio * (colors.length - 1);
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(colors.length - 1, lowerIndex + 1);
  return interpolateColor(colors[lowerIndex], colors[upperIndex], scaled - lowerIndex);
}

function renderYearTicks(years) {
  elements.yearTicks.replaceChildren();
  years.forEach((year, index) => {
    const tick = document.createElement("span");
    const position = years.length === 1 ? 0 : (index / (years.length - 1)) * 100;
    const showLabel = years.length <= 8 || index % Math.ceil(years.length / 8) === 0 || year === state.year || index === years.length - 1;
    tick.className = `year-tick${year === state.year ? " is-active" : ""}`;
    tick.style.left = `${position}%`;
    tick.innerHTML = `
      <span class="year-dot"></span>
      ${showLabel ? `<span class="year-tick-label">${year}</span>` : ""}
    `;
    elements.yearTicks.append(tick);
  });
}

function setYearSlider() {
  const years = availableYears();
  if (!years.length) return;

  if (!years.includes(state.year)) {
    state.year = years[years.length - 1];
  }

  const index = years.indexOf(state.year);
  elements.yearSlider.min = "0";
  elements.yearSlider.max = String(years.length - 1);
  elements.yearSlider.disabled = years.length === 1;
  elements.yearSlider.value = String(index);
  elements.yearSlider.dataset.years = JSON.stringify(years);
  elements.yearSlider.setAttribute("aria-valuetext", String(state.year));
  elements.yearValue.value = String(state.year);
  elements.yearValue.textContent = String(state.year);
  const progress = years.length === 1 ? 0 : (index / (years.length - 1)) * 100;
  elements.yearSlider.style.setProperty("--slider-progress", `${progress}%`);
  renderYearTicks(years);
}

function renderElectionButtons() {
  elements.electionOptions.replaceChildren();
  for (const type of availableTypes()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment-button";
    button.textContent = type;
    button.setAttribute("aria-pressed", String(type === state.electionType));
    button.addEventListener("click", () => {
      if (state.electionType === type) return;
      state.electionType = type;
      elements.electionValue.textContent = type;
      renderElectionButtons();
      setYearSlider();
      renderMap();
    });
    elements.electionOptions.append(button);
  }
}

function tooltipMarkup(record, metric) {
  const metricRow = metric === "turnout" ? "" : `<dt>${metricTitle(metric)}</dt><dd>${formatMetric(record[metricField(metric)], metric)}</dd>`;
  return `<dl class="tooltip-grid">
    <dt>Division</dt><dd>${escapeHtml(record.division)}</dd>
    <dt>Dorms</dt><dd>${escapeHtml(record.dorms)}</dd>
    ${metricRow}
    <dt>Turnout Rate</dt><dd>${formatMetric(record.turnoutRate, "turnout")}</dd>
  </dl>`;
}

function updateSnapshot(records) {
  const sum = field => records.reduce((total, r) => total + r[field], 0);
  const registration = sum("registrationNumber");
  const votes = sum("voteCount");
  elements.snapshotTitle.textContent = `${state.year} ${state.electionType}`;
  elements.totalRegistration.textContent = numberFormat.format(registration);
  elements.oneYearRegistration.textContent = numberFormat.format(sum("oneYearRegistrationNumber"));
  elements.totalVotes.textContent = numberFormat.format(votes);
  elements.totalTurnout.textContent = formatMetric(registration ? votes / registration : null, "turnout");
}

function updateLegend(view, scale) {
  if (view.legend) view.legend.remove();
  view.legend = L.control({ position: "bottomright" });
  view.legend.onAdd = () => {
    const container = L.DomUtil.create("div", "map-legend");
    const colors = PALETTES[view.metric];
    const gradient = scale.stops
      ? colors.map((color, i) => `${color} ${100 * (scale.stops[i] - scale.minimum) / (scale.maximum - scale.minimum)}%`).join(", ")
      : colors.join(", ");
    const colorKey = `<div class="legend-gradient" style="background:linear-gradient(90deg, ${gradient})"></div>
      <div class="legend-axis">${scale.ticks.map(v => `<span>${view.metric === "turnout" ? `${Math.round(v * 100)}%` : numberFormat.format(v)}</span>`).join("")}</div>`;
    container.innerHTML = `<strong>${metricTitle(view.metric)}</strong>${colorKey}
      ${view.metric === "turnout" ? '<small class="no-data-key">Gray = no registration denominator</small>' : ''}`;
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  };
  view.legend.addTo(view.map);
}

function renderMap() {
  const records = selectedRecords();
  const byDivision = new Map(records.map(r => [r.divisionId, r]));
  document.querySelector("#registration-subtitle").textContent = `Registered within the past ${state.registrationWindow} ${state.registrationWindow === 1 ? "year" : "years"}`;
  document.querySelectorAll("[data-window]").forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.window) === state.registrationWindow)));
  for (const view of state.maps) {
    const field = metricField(view.metric);
    const scale = metricScale(view.metric);
    if (view.geoLayer) view.geoLayer.remove();
    view.geoLayer = L.geoJSON(state.boundaries, {
      style(feature) {
        const record = byDivision.get(feature.properties.divisionId);
        return { color: "#16394c", weight: 1.5, opacity: 0.95,
          fillColor: colorFor(record?.[field], scale, view.metric), fillOpacity: 0.78 };
      },
      onEachFeature(feature, layer) {
        const record = byDivision.get(feature.properties.divisionId);
        if (!record) return;
        layer.bindTooltip(tooltipMarkup(record, view.metric), { className: "vote-tooltip", sticky: true, direction: "top", opacity: 1 });
        layer.bindPopup(tooltipMarkup(record, view.metric), { className: "division-popup", maxWidth: 320 });
        layer.on({
          popupopen() { layer.closeTooltip(); },
          mouseover(event) { if (layer.isPopupOpen()) layer.closeTooltip(); event.target.setStyle({ weight: 3, color: "#ffffff", fillOpacity: 0.9 }); event.target.bringToFront(); },
          mouseout(event) { view.geoLayer.resetStyle(event.target); },
        });
      },
    }).addTo(view.map);
    updateLegend(view, scale);
  }
  updateSnapshot(records);
}

function initializeMap() {
  const bounds = L.geoJSON(state.boundaries).getBounds();
  for (const metric of ["registration", "votes", "turnout"]) {
    const map = L.map(`map-${metric}`, { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 11, maxZoom: 19, scrollWheelZoom: false });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    map.fitBounds(bounds, { paddingTopLeft: [18, 24], paddingBottomRight: [18, 135] });
    map.setMaxBounds(bounds.pad(1.4));
    state.maps.push({ map, metric, geoLayer: null, legend: null });
  }
  for (const view of state.maps) {
    view.map.on("moveend", () => {
      if (state.syncing) return;
      state.syncing = true;
      try {
        for (const other of state.maps) {
          if (other !== view) other.map.setView(view.map.getCenter(), view.map.getZoom(), { animate: false });
        }
      } finally { state.syncing = false; }
    });
  }
  const observer = new ResizeObserver(() => state.maps.forEach(view => view.map.invalidateSize({ pan: false })));
  state.maps.forEach(view => observer.observe(view.map.getContainer()));
}

function bindControls() {
  document.querySelectorAll("[data-window]").forEach(button => button.addEventListener("click", () => {
    state.registrationWindow = Number(button.dataset.window);
    renderMap();
  }));
  elements.yearSlider.addEventListener("input", () => {
    const years = JSON.parse(elements.yearSlider.dataset.years || "[]");
    state.year = years[Number(elements.yearSlider.value)];
    setYearSlider();
    renderMap();
  });
}

async function start() {
  try {
    if (window.PLTV_DATA) {
      state.records = window.PLTV_DATA.records;
      state.boundaries = window.PLTV_DATA.boundaries;
    } else {
      const responses = await Promise.all([fetch(DATA_URL, {cache: "no-store"}), fetch(BOUNDARY_URL)]);
      if (responses.some(r => !r.ok)) throw new Error("A required data file was not found.");
      [state.records, state.boundaries] = await Promise.all(responses.map(r => r.json()));
    }
    if (!state.records.length || !state.boundaries.features?.length) {
      throw new Error("The generated map data is empty.");
    }

    const types = availableTypes();
    state.electionType = types.includes("Primary") ? "Primary" : types[0];
    const years = availableYears();
    state.year = years[years.length - 1];
    elements.electionValue.textContent = state.electionType;

    renderElectionButtons();
    setYearSlider();
    bindControls();
    initializeMap();
    renderMap();
    elements.loadingState.hidden = true;
  } catch (error) {
    console.error(error);
    elements.loadingState.hidden = true;
    elements.errorState.hidden = false;
  }
}

start();
