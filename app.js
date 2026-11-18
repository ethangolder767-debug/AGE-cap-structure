/*
 * app.js — reads the CSV files in data/, runs the math in capstruct.js and
 * draws the tables. Everything happens in the browser; the only requests
 * are for this site's own files.
 */
(function () {
  'use strict';
  var C = window.CapStruct;
  var r = C.roundHalfUp;

  // ---------- Formatting (round half up first, then add commas) ----------

  function fmt(x, d) {
    return r(x, d).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function dollars(x) { return x === null ? 'n/a' : (x < 0 ? '−$' + fmt(-x, 0) : '$' + fmt(x, 0)); }
  function deduct(x) { return '(' + dollars(x) + ')'; }
  function cents(x) { return x === null ? 'n/a' : '$' + fmt(x, 2); }
  function pct(x) { return x === null ? 'n/a' : fmt(x * 100, 2) + '%'; }
  function times(x) { return x === null ? 'n/a' : fmt(x, 2) + '×'; }
  function multiple(x) { return x === null ? 'n/a' : fmt(x, 2); }
  function shares(x) { return x === null ? 'n/a' : fmt(x, 2); }

  // ---------- Tiny DOM helpers (textContent only, never innerHTML) ----------

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) {
      if (k === null || k === undefined) return;
      e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return e;
  }
  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---------- Loading ----------

  var files = {
    cdss: 'data/cdss.csv',
    assumptions: 'data/assumptions.csv',
    banker: 'data/banker_schedule.csv',
    firms: 'data/example_firms.csv',
    scenarios: 'data/ebit_scenarios.csv'
  };

  function load() {
    var keys = Object.keys(files);
    return Promise.all(keys.map(function (k) {
      return fetch(files[k], { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('Could not load ' + files[k] + ' (' + res.status + ')');
        return res.text();
      });
    })).then(function (texts) {
      var t = {};
      keys.forEach(function (k, i) { t[k] = texts[i]; });
      return C.buildInputs(t);
    });
  }

  // ---------- Question c: Firm U and Firm L ----------

  function firmTable(name, firm, tax) {
    var y = firm.years;
    var head = el('tr', {}, [el('th', { scope: 'col' }, [''])].concat(
      y.map(function (yr) { return el('th', { scope: 'col' }, ['p = ' + fmt(yr.probability, 2)]); })));

    function line(label, get, cls) {
      return el('tr', cls ? { class: cls } : {}, [el('th', { scope: 'row' }, [label])].concat(
        y.map(function (yr) { return el('td', {}, [get(yr)]); })));
    }
    function stat(label, value) {
      return el('tr', { class: 'stat' }, [el('th', { scope: 'row' }, [label]),
        el('td', { colspan: String(y.length) }, [value])]);
    }

    var body = el('tbody', {}, [
      line('Assets', function () { return dollars(firm.assets); }),
      line('Debt', function () { return dollars(firm.debt); }),
      line('Equity', function () { return dollars(firm.equity); }),
      line('Sales', function (yr) { return dollars(yr.sales); }, 'top-rule'),
      line('Oper. costs', function (yr) { return deduct(yr.operatingCosts); }),
      line('EBIT', function (yr) { return dollars(yr.ebit); }, 'sub'),
      line('Interest', function (yr) { return deduct(yr.interest); }),
      line('EBT', function (yr) { return dollars(yr.ebt); }, 'sub'),
      line('Taxes (' + pct(tax) + ')', function (yr) { return deduct(yr.taxes); }),
      line('Net income', function (yr) { return dollars(yr.netIncome); }, 'sub'),
      line('ROE', function (yr) { return pct(yr.roe); }, 'top-rule'),
      line('TIE', function (yr) { return times(yr.tie); }),
      stat('E(ROE)', firm.roe ? pct(firm.roe.expected) : 'n/a'),
      stat('σ(ROE)', firm.roe ? pct(firm.roe.sd) : 'n/a'),
      stat('CV(ROE)', firm.roe ? multiple(firm.roe.cv) : 'n/a'),
      stat('E(TIE)', firm.tie ? times(firm.tie.expected) : 'n/a'),
      stat('σ(TIE)', firm.tie ? times(firm.tie.sd) : 'n/a')
    ]);

    return el('figure', { class: 'firm' }, [
      el('figcaption', {}, [name]),
      el('table', { class: 'firm-table' }, [el('thead', {}, [head]), body])
    ]);
  }

  function renderFirms(inputs) {
    var f = C.exampleFirms(inputs);
    var box = $('firms');
    clear(box);
    box.appendChild(firmTable('Firm U (no debt)', f.U, inputs.tax));
    box.appendChild(firmTable('Firm L (' + dollars(f.L.debt) + ' of debt at ' +
      pct(inputs.firms.interestRate) + ')', f.L, inputs.tax));
  }

  // ---------- Question d: CDSS ----------

  function renderInputs(inputs) {
    var c = inputs.cdss;
    var items = [
      ['Sales', dollars(c.sales)],
      ['Variable costs', pct(c.variableCostRate) + ' of sales'],
      ['Fixed costs', dollars(c.fixedCosts)],
      ['EBIT', dollars(C.cdssEbit(c))],
      ['Tax rate', pct(inputs.tax)],
      ['Shares outstanding', fmt(c.shares, 0)],
      ['Price today', cents(c.price)],
      ['Total book assets', dollars(c.totalAssets)]
    ];
    var dl = $('cdss-inputs');
    clear(dl);
    items.forEach(function (it) {
      dl.appendChild(el('div', {}, [el('dt', {}, [it[0]]), el('dd', {}, [it[1]])]));
    });
  }

  // A table that turns into stacked cards on a phone. Each cell carries its
  // column name in data-label so the card can show it.
  function dataTable(columns, rows, bestDebt) {
    var thead = el('thead', {}, [el('tr', {}, columns.map(function (col) {
      return el('th', { scope: 'col' }, [col.label]);
    }))]);
    var tbody = el('tbody', {}, rows.map(function (row) {
      var isBest = row.debt === bestDebt;
      return el('tr', isBest ? { class: 'best' } : {}, columns.map(function (col, i) {
        var kids = [col.get(row)];
        if (i === 0 && isBest) kids.push(el('span', { class: 'badge' }, ['highest price']));
        var attrs = { 'data-label': col.label };
        if (i === 0) attrs.scope = 'row';
        return el(i === 0 ? 'th' : 'td', attrs, kids);
      }));
    }));
    return el('table', { class: 'data-table' }, [thead, tbody]);
  }

  function renderCdss(inputs) {
    var rows = C.cdssTable(inputs);
    var s = C.cdssSummary(rows);

    var debtCol = { label: 'Debt', get: function (x) { return dollars(x.debt); } };

    $('earnings').replaceChildren(dataTable([
      debtCol,
      { label: 'r_d', get: function (x) { return x.costOfDebt === null ? '—' : pct(x.costOfDebt); } },
      { label: 'r_s', get: function (x) { return pct(x.costOfEquity); } },
      { label: 'Interest', get: function (x) { return dollars(x.interest); } },
      { label: 'Net income', get: function (x) { return dollars(x.netIncome); } },
      { label: 'TIE', get: function (x) { return times(x.tie); } }
    ], rows, null));

    $('case-method').replaceChildren(dataTable([
      debtCol,
      { label: 'Shares repurchased', get: function (x) { return shares(x.caseMethod.repurchased); } },
      { label: 'Shares remaining', get: function (x) { return shares(x.caseMethod.remaining); } },
      { label: 'EPS', get: function (x) { return cents(x.caseMethod.eps); } },
      { label: 'TIE', get: function (x) { return times(x.tie); } },
      { label: 'Share price', get: function (x) { return cents(x.caseMethod.price); } },
      { label: 'WACC (book weights)', get: function (x) { return pct(x.caseMethod.wacc); } }
    ], rows, s.bestPriceCase));

    $('new-method').replaceChildren(dataTable([
      debtCol,
      { label: 'Equity value S', get: function (x) { return dollars(x.newPriceMethod.equityValue); } },
      { label: 'Firm value V', get: function (x) { return dollars(x.newPriceMethod.firmValue); } },
      { label: 'Share price', get: function (x) { return cents(x.newPriceMethod.price); } },
      { label: 'Shares repurchased', get: function (x) { return shares(x.newPriceMethod.repurchased); } },
      { label: 'Shares remaining', get: function (x) { return shares(x.newPriceMethod.remaining); } },
      { label: 'EPS', get: function (x) { return cents(x.newPriceMethod.eps); } },
      { label: 'TIE', get: function (x) { return times(x.tie); } },
      { label: 'WACC (market weights)', get: function (x) { return pct(x.newPriceMethod.wacc); } }
    ], rows, s.bestPriceNew));

    renderSummary(s);
    renderWarnings(C.cdssWarnings(inputs, rows));
  }

  function renderSummary(s) {
    var list = [
      ['Highest price, $20 buyback', s.bestPriceCase],
      ['Highest price, new-price buyback', s.bestPriceNew],
      ['Lowest WACC, book weights', s.lowestWaccBook],
      ['Lowest WACC, market weights', s.lowestWaccMarket],
      ['Highest EPS, $20 buyback', s.highestEpsCase],
      ['Highest EPS, new-price buyback', s.highestEpsNew]
    ];
    var ul = $('summary-list');
    clear(ul);
    list.forEach(function (it) {
      ul.appendChild(el('li', {}, [el('span', {}, [it[0]]), el('strong', {}, [dollars(it[1])])]));
    });
    var four = [s.bestPriceCase, s.bestPriceNew, s.lowestWaccBook, s.lowestWaccMarket];
    var agree = four.every(function (d) { return d === four[0]; });
    $('summary-note').textContent = agree
      ? 'Both price measures and both WACC measures point to ' + dollars(four[0]) + ' of debt.'
      : 'These measures do not all agree, so the app does not pick one. Look at which value investors actually pay.';
  }

  function renderWarnings(list) {
    var box = $('warnings');
    clear(box);
    box.hidden = list.length === 0;
    list.forEach(function (w) { box.appendChild(el('p', {}, [w])); });
  }

  function showError(err) {
    var box = $('warnings');
    clear(box);
    box.hidden = false;
    box.appendChild(el('p', {}, ['The app could not read its data: ' + err.message]));
    if (location.protocol === 'file:') {
      box.appendChild(el('p', {}, ['Browsers block reading files from a page opened straight from disk. ' +
        'Open the published GitHub Pages address instead.']));
    }
  }

  load().then(function (inputs) {
    renderFirms(inputs);
    renderInputs(inputs);
    renderCdss(inputs);
  }).catch(showError);
})();
