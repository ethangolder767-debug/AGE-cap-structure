/*
 * capstruct.js — the finance math for the AGE capital structure app.
 *
 * Every function here is plain math: none of them touch the page. That lets
 * us check them with Node (node -e "const c = require('./capstruct.js'); ...")
 * as well as use them in the browser, where they live on window.CapStruct.
 *
 * Notation (from CLAUDE.md): T = tax rate, D = amount borrowed,
 * n = shares outstanding before any buyback, P0 = today's price,
 * A = total book assets, r_d = cost of debt, r_s = cost of equity.
 */
(function (global) {
  'use strict';

  // ---------- Rounding and CSV parsing ----------

  // Round half up on the decimal value. toFixed() rounds the binary value,
  // so 14.025 can come out as 14.02. toPrecision(12) strips the binary noise
  // first, so 14.025 becomes 14.03 as the AGE solution shows.
  function roundHalfUp(x, d) {
    if (x === null || !isFinite(x)) return x;
    var f = Math.pow(10, d);
    var sign = x < 0 ? -1 : 1;
    return (sign * Math.round(Number((Math.abs(x) * f).toPrecision(12)))) / f;
  }

  // A small CSV reader that handles quoted fields. Returns an array of
  // objects keyed by the header row.
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = [], row = [], field = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else { field += c; }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) {
      return r.some(function (f) { return f.trim() !== ''; });
    });
    if (!rows.length) return [];
    var header = rows.shift().map(function (h) { return h.trim(); });
    return rows.map(function (r) {
      var o = {};
      header.forEach(function (h, j) { o[h] = (r[j] || '').trim(); });
      return o;
    });
  }

  // Turn a CSV cell into a number. Blank cells become null.
  function num(s, what) {
    if (s === undefined || s === null || String(s).trim() === '') return null;
    var v = Number(s);
    if (!isFinite(v)) throw new Error('Not a number: "' + s + '" (' + what + ')');
    return v;
  }

  // Read item,value style files (cdss.csv, assumptions.csv, example_firms.csv).
  function itemMap(rows, keyCol, file) {
    var m = {};
    rows.forEach(function (r) { m[r[keyCol]] = num(r.value, file + ' ' + r[keyCol]); });
    return function need(key) {
      if (m[key] === undefined || m[key] === null) {
        throw new Error(file + ' is missing "' + key + '"');
      }
      return m[key];
    };
  }

  // ---------- Reading the data files ----------

  // texts: { cdss, assumptions, banker, firms, scenarios } (raw CSV text)
  function buildInputs(texts) {
    var tax = itemMap(parseCSV(texts.assumptions), 'assumption', 'assumptions.csv')('tax_rate');

    var c = itemMap(parseCSV(texts.cdss), 'item', 'cdss.csv');
    var cdss = {
      sales: c('sales'),
      variableCostRate: c('variable_cost_rate'),
      fixedCosts: c('fixed_costs'),
      totalAssets: c('total_assets'),
      debt: c('debt'),
      shares: c('shares_outstanding'),
      price: c('share_price'),
      managementShare: c('management_share')
    };

    var schedule = parseBankerSchedule(texts.banker, 'banker_schedule.csv');

    var f = itemMap(parseCSV(texts.firms), 'item', 'example_firms.csv');
    var firms = {
      totalAssets: f('total_assets'),
      firmLDebt: f('firm_l_debt'),
      interestRate: f('interest_rate'),
      sliderMax: f('slider_max'),
      sliderStep: f('slider_step')
    };

    var scenarios = parseCSV(texts.scenarios).map(function (r, i) {
      return {
        probability: num(r.probability, 'ebit_scenarios.csv row ' + (i + 1)),
        sales: num(r.sales, 'ebit_scenarios.csv row ' + (i + 1)),
        operatingCosts: num(r.operating_costs, 'ebit_scenarios.csv row ' + (i + 1))
      };
    });
    var totalP = scenarios.reduce(function (s, x) { return s + x.probability; }, 0);
    if (Math.abs(totalP - 1) > 1e-9) {
      throw new Error('ebit_scenarios.csv probabilities add up to ' + totalP + ', not 1');
    }

    return { tax: tax, cdss: cdss, schedule: schedule, firms: firms, scenarios: scenarios };
  }

  function parseBankerSchedule(text, file) {
    var rows = parseCSV(text).map(function (r, i) {
      var row = {
        debt: num(r.debt, file + ' row ' + (i + 1) + ' debt'),
        costOfDebt: num(r.cost_of_debt, file + ' row ' + (i + 1) + ' cost_of_debt'),
        costOfEquity: num(r.cost_of_equity, file + ' row ' + (i + 1) + ' cost_of_equity')
      };
      if (row.debt === null || row.costOfEquity === null) {
        throw new Error(file + ' row ' + (i + 1) + ' needs debt and cost_of_equity');
      }
      if (row.debt > 0 && row.costOfDebt === null) {
        throw new Error(file + ' row ' + (i + 1) + ' borrows money but has no cost_of_debt');
      }
      return row;
    });
    rows.sort(function (a, b) { return a.debt - b.debt; });
    return rows;
  }

  // ---------- Question c: Firm U and Firm L ----------

  function weightedStats(values, probs) {
    var mean = 0, variance = 0;
    values.forEach(function (v, i) { mean += probs[i] * v; });
    values.forEach(function (v, i) { variance += probs[i] * Math.pow(v - mean, 2); });
    var sd = Math.sqrt(variance);
    return { expected: mean, sd: sd, cv: mean !== 0 ? sd / mean : null };
  }

  // One firm with a given amount of debt at the given interest rate.
  function exampleFirm(scenarios, totalAssets, debt, rate, tax) {
    var equity = totalAssets - debt;
    var years = scenarios.map(function (s) {
      var ebit = s.sales - s.operatingCosts;
      var interest = rate * debt;
      var ebt = ebit - interest;
      var taxes = tax * ebt;
      var netIncome = ebt - taxes;
      return {
        probability: s.probability,
        sales: s.sales,
        operatingCosts: s.operatingCosts,
        ebit: ebit,
        interest: interest,
        ebt: ebt,
        taxes: taxes,
        netIncome: netIncome,
        roe: equity > 0 ? netIncome / equity : null,
        tie: interest > 0 ? ebit / interest : null   // no interest → n/a
      };
    });
    var probs = years.map(function (y) { return y.probability; });
    var roe = years.every(function (y) { return y.roe !== null; })
      ? weightedStats(years.map(function (y) { return y.roe; }), probs) : null;
    var tie = years.every(function (y) { return y.tie !== null; })
      ? weightedStats(years.map(function (y) { return y.tie; }), probs) : null;
    return { assets: totalAssets, debt: debt, equity: equity, years: years, roe: roe, tie: tie };
  }

  function exampleFirms(inputs, firmLDebt) {
    var f = inputs.firms;
    var dL = firmLDebt === undefined ? f.firmLDebt : firmLDebt;
    return {
      U: exampleFirm(inputs.scenarios, f.totalAssets, 0, f.interestRate, inputs.tax),
      L: exampleFirm(inputs.scenarios, f.totalAssets, dL, f.interestRate, inputs.tax)
    };
  }

  // ---------- Question d: CDSS at each amount of borrowing ----------

  function cdssEbit(c) {
    return c.sales * (1 - c.variableCostRate) - c.fixedCosts;
  }

  function cdssRow(c, tax, b) {
    var ebit = cdssEbit(c);
    var D = b.debt, rd = b.costOfDebt, rs = b.costOfEquity;
    var n = c.shares, P0 = c.price, A = c.totalAssets;
    var interest = D > 0 ? rd * D : 0;
    var netIncome = (ebit - interest) * (1 - tax);
    var tie = interest > 0 ? ebit / interest : null;
    var afterTaxRd = D > 0 ? rd * (1 - tax) : 0;

    // Case method, d(3) and d(4): buy back at today's price P0.
    var caseRepurchased = D / P0;
    var caseRemaining = n - caseRepurchased;
    var caseValid = caseRemaining > 0;
    var caseEps = caseValid ? netIncome / caseRemaining : null;
    var casePrice = caseValid ? caseEps / rs : null;  // g = 0, dividends = EPS
    var waccBook = (D / A) * afterTaxRd + ((A - D) / A) * rs;

    // New-price method: buy back at the price after the announcement.
    var S = netIncome / rs;
    var V = S + D;
    var newPrice = V / n;
    var newRepurchased = D / newPrice;
    var newRemaining = n - newRepurchased;
    var newEps = netIncome / newRemaining;
    var waccMarket = (D / V) * afterTaxRd + (S / V) * rs;

    return {
      debt: D, costOfDebt: D > 0 ? rd : null, costOfEquity: rs,
      ebit: ebit, interest: interest, netIncome: netIncome, tie: tie,
      caseMethod: {
        valid: caseValid,
        repurchased: caseRepurchased, remaining: caseRemaining,
        eps: caseEps, dps: caseEps, price: casePrice, wacc: waccBook,
        management: managementStake(c, caseRepurchased, caseRemaining)
      },
      newPriceMethod: {
        equityValue: S, firmValue: V,
        repurchased: newRepurchased, remaining: newRemaining,
        eps: newEps, dps: newEps, price: newPrice, wacc: waccMarket,
        management: managementStake(c, newRepurchased, newRemaining),
        // Checks from CLAUDE.md: EPS = r_s × P, and WACC = EBIT(1 − T) / V.
        epsCheck: rs * newPrice,
        waccCheck: (ebit * (1 - tax)) / V
      }
    };
  }

  // Management's share of the company after the buyback. Management doesn't
  // sell, so only outside investors' shares can be bought back.
  //   status 'ok'   → stake = management's shares / shares remaining
  //   status 'all'  → the buyback takes every outside share: 100%
  //   status 'over' → the buyback needs more shares than outsiders own
  function managementStake(c, repurchased, remaining) {
    var mgmtShares = c.managementShare * c.shares;
    var outsideShares = c.shares - mgmtShares;
    var tol = 1e-9 * c.shares;
    if (repurchased > outsideShares + tol) return { status: 'over', stake: null };
    if (Math.abs(repurchased - outsideShares) <= tol) return { status: 'all', stake: 1 };
    return { status: 'ok', stake: mgmtShares / remaining };
  }

  // Where a button should move the CDSS slider. The case method's amount
  // wins when the two methods disagree; the page then names both.
  function chooseTarget(caseDebt, newDebt) {
    return { debt: caseDebt, split: caseDebt !== newDebt, caseDebt: caseDebt, newDebt: newDebt };
  }

  // The Firm L slider's stops: 0 to slider_max in steps of slider_step.
  function firmLStops(firms) {
    var stops = [];
    var count = Math.floor(firms.sliderMax / firms.sliderStep + 1e-9);
    for (var i = 0; i <= count; i++) stops.push(i * firms.sliderStep);
    return stops;
  }

  function cdssTable(inputs, schedule) {
    var s = schedule || inputs.schedule;
    return s.map(function (b) { return cdssRow(inputs.cdss, inputs.tax, b); });
  }

  // Pick the row that maximises (or minimises) a value. Ties go to the
  // smaller amount of debt, because rows are sorted by debt and we only
  // switch on a strictly better value.
  function pick(rows, get, wantMax) {
    var best = null, bestV = null;
    rows.forEach(function (r) {
      var v = get(r);
      if (v === null || v === undefined || !isFinite(v)) return;
      var tol = 1e-12 * Math.max(1, Math.abs(v));
      if (best === null || (wantMax ? v > bestV + tol : v < bestV - tol)) {
        best = r; bestV = v;
      }
    });
    return best ? best.debt : null;
  }

  function cdssSummary(rows) {
    return {
      bestPriceCase: pick(rows, function (r) { return r.caseMethod.price; }, true),
      bestPriceNew: pick(rows, function (r) { return r.newPriceMethod.price; }, true),
      lowestWaccBook: pick(rows, function (r) { return r.caseMethod.wacc; }, false),
      lowestWaccMarket: pick(rows, function (r) { return r.newPriceMethod.wacc; }, false),
      highestEpsCase: pick(rows, function (r) { return r.caseMethod.eps; }, true),
      highestEpsNew: pick(rows, function (r) { return r.newPriceMethod.eps; }, true)
    };
  }

  // Problems worth showing on the page rather than hiding.
  function cdssWarnings(inputs, rows) {
    var w = [];
    var zero = rows.filter(function (r) { return r.debt === 0; })[0];
    if (!zero) {
      w.push('The banker\'s schedule has no $0 row, so the app cannot check today\'s price.');
    } else {
      var implied = zero.caseMethod.eps / zero.costOfEquity;
      if (Math.abs(implied - inputs.cdss.price) > 0.005) {
        w.push('At $0 of debt, EPS / r_s = $' + roundHalfUp(implied, 2).toFixed(2) +
          ', but cdss.csv says today\'s price is $' + roundHalfUp(inputs.cdss.price, 2).toFixed(2) +
          '. The schedule\'s cost of equity at $0 does not match the market price.');
      }
    }
    if (inputs.cdss.debt !== 0) {
      w.push('cdss.csv shows existing debt of $' + inputs.cdss.debt +
        '. The case assumes CDSS starts with no debt, and this app does too.');
    }
    rows.forEach(function (r) {
      if (!r.caseMethod.valid) {
        w.push('At $' + r.debt + ' of debt, buying back at today\'s price would retire every share.');
      }
      var n = r.newPriceMethod;
      if (Math.abs(n.eps - n.epsCheck) > 1e-9 * Math.max(1, Math.abs(n.eps)) ||
          Math.abs(n.wacc - n.waccCheck) > 1e-12) {
        w.push('The new-price method\'s checks fail at $' + r.debt + ' of debt.');
      }
    });
    return w;
  }

  var api = {
    roundHalfUp: roundHalfUp,
    parseCSV: parseCSV,
    buildInputs: buildInputs,
    parseBankerSchedule: parseBankerSchedule,
    weightedStats: weightedStats,
    exampleFirm: exampleFirm,
    exampleFirms: exampleFirms,
    cdssEbit: cdssEbit,
    cdssRow: cdssRow,
    cdssTable: cdssTable,
    cdssSummary: cdssSummary,
    cdssWarnings: cdssWarnings,
    managementStake: managementStake,
    chooseTarget: chooseTarget,
    firmLStops: firmLStops
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CapStruct = api;
})(typeof window !== 'undefined' ? window : this);
