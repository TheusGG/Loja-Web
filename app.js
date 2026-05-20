let token = sessionStorage.getItem("lojinha-token") || "";
let currentUser = null;
let products = [];
let users = [];
let sales = [];
let reports = null;
let timeClock = [];
let cart = [];
let selectedSaleProduct = null;

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const apiBase = window.location.protocol === "file:" ? "http://localhost:3000" : "";

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
  } catch {
    throw new Error("Servidor fora do ar. Abra ou reinicie o iniciar-lojinha.cmd e acesse http://localhost:3000.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Falha na requisição.");
  return data;
}

async function bootstrap() {
  if (!token) return;

  try {
    await refreshData();
    showSystem();
  } catch {
    token = "";
    sessionStorage.removeItem("lojinha-token");
  }
}

function isSupervisor() {
  return (currentUser?.role || currentUser?.cargo) === "Supervisor";
}

function isAdmin() {
  return (currentUser?.role || currentUser?.cargo) === "Adm";
}

function canManageProducts() {
  return isAdmin() || isSupervisor();
}

function canManageUsers() {
  return isAdmin();
}

function canViewUsers() {
  return isAdmin() || isSupervisor();
}

function canViewReports() {
  return isAdmin();
}

function setMessage(selector, text, isError = false) {
  const element = $(selector);
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("danger-text", isError);
}

function centsFromInput(selector) {
  return Math.round((Number($(selector).value) || 0) * 100);
}

function centsToMoney(cents) {
  return money.format((Number(cents) || 0) / 100);
}

function formatDate(value) {
  return new Date(value).toLocaleString("pt-BR");
}

function showSystem() {
  $("#login-screen").classList.add("hidden");
  $("#system-screen").classList.remove("hidden");
  $("#system-screen").classList.toggle("attendant-mode", !canManageProducts());
  $("#current-user").textContent = currentUser.name;
  $("#user-role").textContent = currentUser.role || currentUser.cargo;

  document.querySelectorAll(".admin-only").forEach((element) => {
    element.classList.toggle("hidden", !isAdmin());
  });
  document.querySelectorAll(".manager-only").forEach((element) => {
    element.classList.toggle("hidden", !canViewUsers());
  });
  document.querySelectorAll(".supervisor-panel").forEach((element) => {
    element.classList.toggle("hidden", !canManageProducts());
  });

  if (!canViewUsers() && activeView() === "users") routeTo("dashboard");
  if (!canViewReports() && activeView() === "reports") routeTo("dashboard");
  renderAll();
}

async function login(event) {
  event.preventDefault();
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        login: $("#login-user").value.trim(),
        password: $("#login-password").value
      })
    });

    token = data.token;
    currentUser = {
      name: data.user.name,
      login: data.user.login,
      role: data.user.cargo
    };
    sessionStorage.setItem("lojinha-token", token);
    $("#login-error").textContent = "";
    await refreshData();
    showSystem();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
}

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  token = "";
  currentUser = null;
  cart = [];
  sessionStorage.removeItem("lojinha-token");
  $("#system-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  $("#login-password").value = "";
}

async function refreshData() {
  const data = await api("/api/bootstrap");
  currentUser = data.user;
  products = data.products;
  users = data.users || [];
  sales = data.sales;
  reports = data.reports;
  timeClock = data.timeClock || [];
}

async function refreshReports() {
  if (!canViewReports()) return;
  reports = await api("/api/reports");
}

function activeView() {
  return document.querySelector(".view.active-view")?.id || "dashboard";
}

function routeTo(viewName) {
  if (!canViewUsers() && viewName === "users") return;
  if (!canViewReports() && viewName === "reports") return;

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active-view", view.id === viewName);
  });
  const titles = {
    dashboard: "Painel",
    products: "Produtos",
    sales: "Vendas",
    timeclock: "Ponto",
    history: "Histórico",
    reports: "Relatórios",
    users: "Usuários"
  };
  $("#view-title").textContent = titles[viewName];
  renderAll();
}

async function upsertProduct(event) {
  event.preventDefault();
  if (!canManageProducts()) return;

  const product = {
    code: $("#product-code").value.trim(),
    name: $("#product-name").value.trim(),
    category: $("#product-category").value,
    quantity: Number($("#product-quantity").value),
    minStock: Number($("#product-min-stock").value),
    costCents: centsFromInput("#product-cost"),
    priceCents: centsFromInput("#product-price")
  };

  if (product.priceCents < product.costCents) {
    setMessage("#product-message", "Preço de venda deve ser maior ou igual ao custo.", true);
    return;
  }

  try {
    await api("/api/products", { method: "POST", body: JSON.stringify(product) });
    await refreshData();
    clearProductForm();
    setMessage("#product-message", "Produto salvo.");
    renderAll();
  } catch (error) {
    setMessage("#product-message", error.message, true);
  }
}

function editProduct(code) {
  if (!canManageProducts()) return;
  const product = products.find((item) => item.code === code);
  if (!product) return;

  $("#product-code").value = product.code;
  $("#product-name").value = product.name;
  $("#product-category").value = product.category;
  $("#product-quantity").value = product.quantity;
  $("#product-min-stock").value = product.minStock ?? 5;
  $("#product-cost").value = (product.costCents / 100).toFixed(2);
  $("#product-price").value = (product.priceCents / 100).toFixed(2);
  $("#product-code").focus();
}

async function deleteProduct(code) {
  if (!canManageProducts()) return;
  const product = products.find((item) => item.code === code);
  const label = product ? product.name : code;
  if (!confirm(`Excluir o produto "${label}"?`)) return;

  try {
    await api(`/api/products/${encodeURIComponent(code)}`, { method: "DELETE" });
    cart = cart.filter((item) => item.code !== code);
    await refreshData();
    renderAll();
  } catch (error) {
    setMessage("#product-message", error.message, true);
  }
}

async function adjustProductStock(code) {
  if (!canManageProducts()) return;
  const product = products.find((item) => item.code === code);
  if (!product) return;

  const value = prompt(`Novo estoque para ${product.name}:`, String(product.quantity));
  if (value === null) return;

  try {
    await api(`/api/products/${encodeURIComponent(code)}/stock`, {
      method: "POST",
      body: JSON.stringify({ quantity: Number(value) })
    });
    await refreshData();
    setMessage("#product-message", "Estoque atualizado.");
    renderAll();
  } catch (error) {
    setMessage("#product-message", error.message, true);
  }
}

function clearProductForm() {
  $("#product-form").reset();
  $("#product-category").value = "Higiene";
  $("#product-min-stock").value = 5;
}

function filteredProducts() {
  const term = $("#product-search").value.trim().toLowerCase();
  if (!term) return products;
  return products.filter((product) => {
    return product.code.toLowerCase().includes(term) || product.name.toLowerCase().includes(term);
  });
}

function renderProductSuggestions() {
  $("#product-suggestions").innerHTML = products.map((product) => `
    <option value="${escapeHtml(product.code)}">${escapeHtml(product.name)}</option>
    <option value="${escapeHtml(product.name)}">${escapeHtml(product.code)}</option>
  `).join("");
}

function renderProducts() {
  $("#products-table").innerHTML = filteredProducts().map((product) => {
    const critical = product.quantity <= (product.minStock ?? 5);
    return `
      <tr class="${critical ? "critical-row" : ""}">
        <td>${escapeHtml(product.code)}</td>
        <td>${escapeHtml(product.name)}</td>
        <td>${escapeHtml(product.category)}</td>
        <td>${product.quantity}</td>
        <td>${product.minStock ?? 5}</td>
        <td>${centsToMoney(product.priceCents)}</td>
        <td>
          ${canManageProducts() ? `
            <span class="row-actions">
              <button class="link-button" type="button" data-edit-product="${escapeHtml(product.code)}">Editar</button>
              <button class="link-button" type="button" data-stock-product="${escapeHtml(product.code)}">Estoque</button>
              <button class="link-button delete-button" type="button" data-delete-product="${escapeHtml(product.code)}">Excluir</button>
            </span>
          ` : ""}
        </td>
      </tr>
    `;
  }).join("");
  renderProductSuggestions();
}

function findSaleProduct() {
  const term = $("#sale-code").value.trim().toLowerCase();
  selectedSaleProduct = products.find((product) => {
    return product.code.toLowerCase() === term || product.name.toLowerCase() === term;
  }) || products.find((product) => product.name.toLowerCase().includes(term)) || null;

  if (!selectedSaleProduct) {
    $("#sale-name").value = "";
    $("#sale-price").value = "";
    updateSaleTotal();
    setMessage("#sale-message", "Produto não encontrado.", true);
    return;
  }

  $("#sale-code").value = selectedSaleProduct.code;
  $("#sale-name").value = selectedSaleProduct.name;
  $("#sale-price").value = (selectedSaleProduct.priceCents / 100).toFixed(2);
  updateSaleTotal();
  setMessage("#sale-message", `Estoque disponível: ${selectedSaleProduct.quantity}.`);
}

function updateSaleTotal() {
  const quantity = Number($("#sale-quantity").value) || 0;
  const discount = centsFromInput("#sale-item-discount");
  const gross = selectedSaleProduct ? quantity * selectedSaleProduct.priceCents : 0;
  $("#sale-item-total").textContent = centsToMoney(Math.max(0, gross - discount));
}

function addSaleItem() {
  const quantity = Number($("#sale-quantity").value) || 0;
  const discountCents = centsFromInput("#sale-item-discount");

  if (!selectedSaleProduct) {
    setMessage("#sale-message", "Pesquise um produto antes de adicionar.", true);
    return;
  }

  if (quantity <= 0 || quantity > selectedSaleProduct.quantity) {
    setMessage("#sale-message", "Quantidade inválida ou acima do estoque.", true);
    return;
  }

  if (discountCents > quantity * selectedSaleProduct.priceCents) {
    setMessage("#sale-message", "Desconto maior que o total do item.", true);
    return;
  }

  const currentQuantity = cart
    .filter((item) => item.code === selectedSaleProduct.code)
    .reduce((sum, item) => sum + item.quantity, 0);

  if (currentQuantity + quantity > selectedSaleProduct.quantity) {
    setMessage("#sale-message", "Quantidade acumulada acima do estoque.", true);
    return;
  }

  cart.push({
    code: selectedSaleProduct.code,
    name: selectedSaleProduct.name,
    quantity,
    unitPriceCents: selectedSaleProduct.priceCents,
    discountCents
  });

  clearSaleFields();
  setMessage("#sale-message", "Item adicionado.");
  renderCart();
}

function removeCartItem(index) {
  cart.splice(Number(index), 1);
  renderCart();
}

function clearCart() {
  if (!cart.length) return;
  if (!confirm("Limpar todos os itens do carrinho?")) return;
  cart = [];
  $("#sale-discount").value = 0;
  renderCart();
}

async function finishSale() {
  if (!cart.length) {
    setMessage("#sale-message", "Adicione itens antes de registrar.", true);
    return;
  }

  try {
    await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({ items: cart, discountCents: centsFromInput("#sale-discount") })
    });
    cart = [];
    $("#sale-discount").value = 0;
    await refreshData();
    await refreshReports();
    setMessage("#sale-message", "Venda registrada.");
    renderAll();
  } catch (error) {
    setMessage("#sale-message", error.message, true);
  }
}

function clearSaleFields() {
  selectedSaleProduct = null;
  $("#sale-code").value = "";
  $("#sale-name").value = "";
  $("#sale-quantity").value = 1;
  $("#sale-price").value = "";
  $("#sale-item-discount").value = 0;
  updateSaleTotal();
}

function cartSubtotal() {
  return cart.reduce((sum, item) => {
    return sum + Math.max(0, item.quantity * item.unitPriceCents - (item.discountCents || 0));
  }, 0);
}

function renderCart() {
  $("#cart-table").innerHTML = cart.map((item, index) => {
    const total = Math.max(0, item.quantity * item.unitPriceCents - (item.discountCents || 0));
    return `
      <tr>
        <td>${escapeHtml(item.code)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td>${item.quantity}</td>
        <td>${centsToMoney(item.unitPriceCents)}</td>
        <td>${centsToMoney(item.discountCents || 0)}</td>
        <td>${centsToMoney(total)}</td>
        <td><button class="link-button delete-button" type="button" data-remove-cart="${index}">Remover</button></td>
      </tr>
    `;
  }).join("");

  const subtotal = cartSubtotal();
  const saleDiscount = centsFromInput("#sale-discount");
  $("#cart-subtotal").textContent = centsToMoney(subtotal);
  $("#cart-total").textContent = centsToMoney(Math.max(0, subtotal - saleDiscount));
}

async function upsertUser(event) {
  event.preventDefault();
  if (!canManageUsers()) return;

  const user = {
    cpf: $("#user-cpf").value.trim(),
    name: $("#user-name").value.trim(),
    login: $("#user-login").value.trim(),
    password: $("#user-password").value,
    email: $("#user-email").value.trim(),
    phone: $("#user-phone").value.trim(),
    cargo: $("#user-cargo").value
  };

  try {
    await api("/api/users", { method: "POST", body: JSON.stringify(user) });
    await refreshData();
    clearUserForm();
    setMessage("#user-message", "Usuário salvo.");
    renderUsers();
  } catch (error) {
    setMessage("#user-message", error.message, true);
  }
}

function editUser(cpf) {
  if (!canManageUsers()) return;
  const user = users.find((item) => item.cpf === cpf);
  if (!user) return;

  $("#user-cpf").value = formatCpf(user.cpf);
  $("#user-name").value = user.name;
  $("#user-login").value = user.login;
  $("#user-password").value = "";
  $("#user-password").required = false;
  $("#user-email").value = user.email || "";
  $("#user-phone").value = user.phone || "";
  $("#user-cargo").value = user.cargo;
}

async function deleteUser(cpf) {
  if (!canManageUsers()) return;
  const user = users.find((item) => item.cpf === cpf);
  const label = user ? user.name : cpf;
  if (!confirm(`Excluir o usuário "${label}"?`)) return;

  try {
    await api(`/api/users/${encodeURIComponent(cpf)}`, { method: "DELETE" });
    await refreshData();
    renderUsers();
  } catch (error) {
    setMessage("#user-message", error.message, true);
  }
}

function clearUserForm() {
  $("#user-form").reset();
  $("#user-cargo").value = "Atendente balcão";
  $("#user-password").required = true;
}

function renderUsers() {
  if (!canViewUsers()) return;
  $("#users-table").innerHTML = users.map((user) => `
    <tr>
      <td>${escapeHtml(user.name)}</td>
      <td>${escapeHtml(user.login)}</td>
      <td>${escapeHtml(user.cargo)}</td>
      <td>
        ${canManageUsers() ? `
          <span class="row-actions">
            <button class="link-button" type="button" data-edit-user="${escapeHtml(user.cpf)}">Editar</button>
            <button class="link-button delete-button" type="button" data-delete-user="${escapeHtml(user.cpf)}">Excluir</button>
          </span>
        ` : ""}
      </td>
    </tr>
  `).join("");
}

function renderDashboard() {
  const stock = products.reduce((sum, product) => sum + product.quantity, 0);
  const revenue = sales.reduce((sum, sale) => sum + sale.totalCents, 0);
  $("#metric-products").textContent = products.length;
  $("#metric-stock").textContent = stock;
  $("#metric-sales").textContent = sales.length;
  $("#metric-revenue").textContent = centsToMoney(revenue);

  const lowStock = products.filter((product) => product.quantity <= (product.minStock ?? 5));
  $("#low-stock-list").innerHTML = lowStock.length
    ? lowStock.map((product) => `
      <div class="stack-item">
        <strong>${escapeHtml(product.name)}</strong>
        <span>${product.quantity} un. / mín. ${product.minStock ?? 5}</span>
      </div>
    `).join("")
    : `<div class="stack-item"><strong>Sem alertas</strong><span>Estoque saudável</span></div>`;

  $("#recent-sales-list").innerHTML = sales.length
    ? sales.slice(0, 5).map((sale) => `
      <div class="stack-item">
        <strong>${centsToMoney(sale.totalCents)}</strong>
        <span>${formatDate(sale.date)} · ${escapeHtml(sale.operator)}</span>
      </div>
    `).join("")
    : `<div class="stack-item"><strong>Nenhuma venda</strong><span>Comece pelo caixa</span></div>`;
}

function renderHistory() {
  $("#sales-history-list").innerHTML = sales.length
    ? sales.map((sale) => `
      <article class="sale-card">
        <div class="sale-card-heading">
          <div>
            <strong>Venda #${sale.id}</strong>
            <span>${formatDate(sale.date)} · ${escapeHtml(sale.operator)}</span>
          </div>
          <strong>${centsToMoney(sale.totalCents)}</strong>
        </div>
        <div class="sale-card-meta">
          <span>Subtotal ${centsToMoney(sale.subtotalCents ?? sale.totalCents)}</span>
          <span>Desconto ${centsToMoney(sale.discountCents || 0)}</span>
        </div>
        <div class="table-wrap">
          <table>
            <tbody>
              ${sale.items.map((item) => `
                <tr>
                  <td>${escapeHtml(item.code)}</td>
                  <td>${escapeHtml(item.name)}</td>
                  <td>${item.quantity} un.</td>
                  <td>${centsToMoney(item.totalCents)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state">Nenhuma venda encontrada.</div>`;
}

async function registerTimeClock(eventType) {
  try {
    const data = await api("/api/time-clock", {
      method: "POST",
      body: JSON.stringify({ eventType })
    });
    timeClock = data.timeClock || [];
    setMessage("#timeclock-message", eventType === "entrada" ? "Entrada registrada." : "Saída registrada.");
    renderTimeClock();
  } catch (error) {
    setMessage("#timeclock-message", error.message, true);
  }
}

async function filterTimeClock() {
  const params = new URLSearchParams();
  if ($("#clock-start").value) params.set("start", $("#clock-start").value);
  if ($("#clock-end").value) params.set("end", $("#clock-end").value);
  if ($("#clock-login").value.trim()) params.set("login", $("#clock-login").value.trim());
  timeClock = await api(`/api/time-clock?${params.toString()}`);
  renderTimeClock();
}

async function clearTimeClockFilter() {
  $("#clock-start").value = "";
  $("#clock-end").value = "";
  $("#clock-login").value = "";
  timeClock = await api("/api/time-clock");
  renderTimeClock();
}

function renderTimeClock() {
  const last = timeClock[0];
  $("#timeclock-last").textContent = last
    ? `${last.eventType === "entrada" ? "Entrada" : "Saída"} em ${formatDate(last.date)}`
    : "Nenhum registro";

  $("#timeclock-table").innerHTML = timeClock.length
    ? timeClock.map((item) => `
      <tr>
        <td>${formatDate(item.date)}</td>
        <td>${escapeHtml(item.name)} <span class="muted-inline">${escapeHtml(item.login)}</span></td>
        <td>${escapeHtml(item.role)}</td>
        <td>${item.eventType === "entrada" ? "Entrada" : "Saída"}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4">Nenhum ponto registrado.</td></tr>`;
}

async function filterHistory() {
  const params = new URLSearchParams();
  if ($("#history-start").value) params.set("start", $("#history-start").value);
  if ($("#history-end").value) params.set("end", $("#history-end").value);
  if ($("#history-operator").value.trim()) params.set("operator", $("#history-operator").value.trim());
  if ($("#history-product").value.trim()) params.set("product", $("#history-product").value.trim());

  sales = await api(`/api/sales?${params.toString()}`);
  renderAll();
}

async function clearHistoryFilter() {
  $("#history-start").value = "";
  $("#history-end").value = "";
  $("#history-operator").value = "";
  $("#history-product").value = "";
  await refreshData();
  renderAll();
}

function renderReports() {
  if (!canViewReports() || !reports) return;

  $("#report-sales").textContent = reports.salesCount || 0;
  $("#report-revenue").textContent = centsToMoney(reports.revenueCents);
  $("#report-profit").textContent = centsToMoney(reports.profitCents);
  $("#report-discount").textContent = centsToMoney(reports.discountCents);

  $("#report-days").innerHTML = reports.byDay?.length
    ? reports.byDay.map((day) => `
      <div class="stack-item">
        <strong>${new Date(`${day.date}T00:00:00`).toLocaleDateString("pt-BR")}</strong>
        <span>${day.salesCount} vendas · ${centsToMoney(day.revenueCents)}</span>
      </div>
    `).join("")
    : `<div class="stack-item"><strong>Sem vendas</strong><span>Nenhum faturamento registrado</span></div>`;

  $("#report-products").innerHTML = reports.topProducts?.length
    ? reports.topProducts.map((product) => `
      <div class="stack-item">
        <strong>${escapeHtml(product.name)}</strong>
        <span>${product.quantity} un. · ${centsToMoney(product.profitCents)} lucro</span>
      </div>
    `).join("")
    : `<div class="stack-item"><strong>Sem produtos</strong><span>Nenhum item vendido</span></div>`;
}

function renderAll() {
  renderDashboard();
  renderProducts();
  renderCart();
  renderHistory();
  renderTimeClock();
  renderReports();
  renderUsers();
}

function formatCpf(value) {
  const digits = onlyDigits(value).slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

function onlyDigits(value) {
  return String(value).replace(/\D/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("submit", (event) => {
  if (event.target.id === "login-form") login(event);
  if (event.target.id === "product-form") upsertProduct(event);
  if (event.target.id === "user-form") upsertUser(event);
});

document.addEventListener("click", (event) => {
  const target = event.target;

  if (target.matches(".nav-item")) routeTo(target.dataset.view);
  if (target.id === "logout-button") logout();
  if (target.id === "clear-product") clearProductForm();
  if (target.id === "clear-user") clearUserForm();
  if (target.id === "find-product") findSaleProduct();
  if (target.id === "add-sale-item") addSaleItem();
  if (target.id === "finish-sale") finishSale();
  if (target.id === "clear-cart") clearCart();
  if (target.id === "filter-history") filterHistory();
  if (target.id === "clear-history-filter") clearHistoryFilter();
  if (target.id === "clock-in") registerTimeClock("entrada");
  if (target.id === "clock-out") registerTimeClock("saida");
  if (target.id === "filter-clock") filterTimeClock();
  if (target.id === "clear-clock-filter") clearTimeClockFilter();
  if (target.dataset.editProduct) editProduct(target.dataset.editProduct);
  if (target.dataset.deleteProduct) deleteProduct(target.dataset.deleteProduct);
  if (target.dataset.stockProduct) adjustProductStock(target.dataset.stockProduct);
  if (target.dataset.removeCart) removeCartItem(target.dataset.removeCart);
  if (target.dataset.editUser) editUser(target.dataset.editUser);
  if (target.dataset.deleteUser) deleteUser(target.dataset.deleteUser);
});

document.addEventListener("input", (event) => {
  if (event.target.id === "product-search") renderProducts();
  if (event.target.id === "sale-quantity") updateSaleTotal();
  if (event.target.id === "sale-item-discount") updateSaleTotal();
  if (event.target.id === "sale-discount") renderCart();
  if (event.target.id === "user-cpf") event.target.value = formatCpf(event.target.value);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.id === "sale-code") {
    event.preventDefault();
    findSaleProduct();
  }
});

bootstrap();
