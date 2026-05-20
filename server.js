import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDir = join(root, "data");
const dbPath = join(dataDir, "lojinha.sqlite");
const port = Number(process.env.PORT || 3000);
const roles = ["Adm", "Supervisor", "Atendente balcão", "Limpeza", "Açougue", "Repositor"];

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    cpf TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    min_stock INTEGER NOT NULL DEFAULT 5 CHECK (min_stock >= 0),
    cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
    price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_login TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
    discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (operator_login) REFERENCES users(login)
  );

  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_code TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_code) REFERENCES products(code)
  );

  CREATE TABLE IF NOT EXISTS time_clock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_login TEXT NOT NULL,
    user_name TEXT NOT NULL,
    role TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('entrada', 'saida')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_login) REFERENCES users(login)
  );
`);

migrateDatabase();
seedDatabase();

const sessions = new Map();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await routeApi(request, response, url);
      return;
    }

    serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.status ? error.message : "Erro interno do servidor." });
    console.error(error);
  }
});

server.listen(port, () => {
  console.log(`Lojinha Web rodando em http://localhost:${port}`);
  console.log(`SQLite: ${dbPath}`);
});

async function routeApi(request, response, url) {
  const method = request.method;
  const session = getSession(request);

  if (method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(request);
    const user = db.prepare("SELECT * FROM users WHERE login = ?").get(body.login || "");

    if (!user || !verifyPassword(body.password || "", user.salt, user.password_hash)) {
      sendJson(response, 401, { error: "Usuário ou senha não encontrado." });
      return;
    }

    const token = randomBytes(32).toString("hex");
    sessions.set(token, { login: user.login, name: user.name, role: user.role });
    sendJson(response, 200, { token, user: publicUser(user) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/logout") {
    const token = getBearerToken(request);
    if (token) sessions.delete(token);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (!session) {
    sendJson(response, 401, { error: "Sessão inválida." });
    return;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(response, 200, {
      user: session,
      products: listProducts(),
      users: canViewUsers(session) ? listUsers() : [],
      sales: listSales(url.searchParams),
      reports: canViewReports(session) ? buildReports() : null,
      timeClock: listTimeClock(session)
    });
    return;
  }

  if (url.pathname === "/api/products") {
    if (method === "GET") sendJson(response, 200, listProducts());
    else if (method === "POST") {
      requireProductManager(session, response);
      if (response.writableEnded) return;
      sendJson(response, 200, saveProduct(await readBody(request)));
    } else sendJson(response, 405, { error: "Método não permitido." });
    return;
  }

  const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch) {
    if (method === "DELETE") {
      requireProductManager(session, response);
      if (response.writableEnded) return;
      deleteProduct(decodeURIComponent(productMatch[1]));
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 405, { error: "Método não permitido." });
    return;
  }

  const stockMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/stock$/);
  if (stockMatch) {
    if (method === "POST") {
      requireProductManager(session, response);
      if (response.writableEnded) return;
      sendJson(response, 200, adjustStock(decodeURIComponent(stockMatch[1]), await readBody(request)));
      return;
    }
    sendJson(response, 405, { error: "Método não permitido." });
    return;
  }

  if (url.pathname === "/api/sales") {
    if (method === "POST") {
      sendJson(response, 201, createSale(await readBody(request), session));
      return;
    }
    if (method === "GET") {
      sendJson(response, 200, listSales(url.searchParams));
      return;
    }
  }

  if (url.pathname === "/api/reports") {
    requireReportViewer(session, response);
    if (response.writableEnded) return;
    sendJson(response, 200, buildReports());
    return;
  }

  if (url.pathname === "/api/users") {
    if (method === "GET") {
      requireUserViewer(session, response);
      if (response.writableEnded) return;
      sendJson(response, 200, listUsers());
    } else if (method === "POST") {
      requireAdmin(session, response);
      if (response.writableEnded) return;
      sendJson(response, 200, saveUser(await readBody(request)));
    }
    else sendJson(response, 405, { error: "Método não permitido." });
    return;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "DELETE") {
    requireAdmin(session, response);
    if (response.writableEnded) return;
    deleteUser(decodeURIComponent(userMatch[1]));
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/time-clock") {
    if (method === "GET") {
      sendJson(response, 200, listTimeClock(session, url.searchParams));
      return;
    }
    if (method === "POST") {
      sendJson(response, 201, createTimeClock(await readBody(request), session));
      return;
    }
    sendJson(response, 405, { error: "Método não permitido." });
    return;
  }

  sendJson(response, 404, { error: "Rota não encontrada." });
}

function canManageProducts(session) {
  return ["Adm", "Supervisor"].includes(session.role);
}

function canManageUsers(session) {
  return session.role === "Adm";
}

function canViewUsers(session) {
  return ["Adm", "Supervisor"].includes(session.role);
}

function canViewReports(session) {
  return session.role === "Adm";
}

function requireAdmin(session, response) {
  if (!canManageUsers(session)) {
    sendJson(response, 403, { error: "Apenas Adm pode alterar usuários." });
  }
}

function requireProductManager(session, response) {
  if (!canManageProducts(session)) {
    sendJson(response, 403, { error: "Apenas Adm ou Supervisor pode alterar produtos." });
  }
}

function requireUserViewer(session, response) {
  if (!canViewUsers(session)) {
    sendJson(response, 403, { error: "Apenas Adm ou Supervisor pode visualizar usuários." });
  }
}

function requireReportViewer(session, response) {
  if (!canViewReports(session)) {
    sendJson(response, 403, { error: "Apenas Adm pode visualizar relatórios." });
  }
}

function serveStatic(pathname, response) {
  const safePath = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8"
  };
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(readFileSync(filePath));
}

function listProducts() {
  return db.prepare(`
    SELECT code, name, category, quantity, min_stock AS minStock, cost_cents AS costCents, price_cents AS priceCents
    FROM products
    ORDER BY name
  `).all();
}

function saveProduct(product) {
  validateProduct(product);
  db.prepare(`
    INSERT INTO products (code, name, category, quantity, min_stock, cost_cents, price_cents, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      quantity = excluded.quantity,
      min_stock = excluded.min_stock,
      cost_cents = excluded.cost_cents,
      price_cents = excluded.price_cents,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    product.code.trim(),
    product.name.trim(),
    normalizeCategory(product.category),
    Number(product.quantity),
    Number(product.minStock),
    Number(product.costCents),
    Number(product.priceCents)
  );
  return { ok: true };
}

function deleteProduct(code) {
  const used = db.prepare("SELECT COUNT(*) AS total FROM sale_items WHERE product_code = ?").get(code).total;
  if (used > 0) throw httpError(400, "Produto já participou de vendas e não pode ser excluído.");

  const result = db.prepare("DELETE FROM products WHERE code = ?").run(code);
  if (!result.changes) throw httpError(404, "Produto não encontrado.");
}

function adjustStock(code, payload) {
  const product = db.prepare("SELECT code, quantity FROM products WHERE code = ?").get(code);
  if (!product) throw httpError(404, "Produto não encontrado.");

  const quantity = Number(payload.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) throw httpError(400, "Quantidade inválida.");

  db.prepare("UPDATE products SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?").run(quantity, code);
  return { ok: true };
}

function listUsers() {
  return db.prepare(`
    SELECT cpf, name, login, email, phone, role AS cargo
    FROM users
    ORDER BY name
  `).all();
}

function listTimeClock(session, searchParams = new URLSearchParams()) {
  const filters = [];
  const params = [];

  if (!canViewUsers(session)) {
    filters.push("user_login = ?");
    params.push(session.login);
  } else {
    const login = searchParams.get("login");
    if (login) {
      filters.push("user_login = ?");
      params.push(login);
    }
  }

  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (start) {
    filters.push("date(created_at) >= date(?)");
    params.push(start);
  }
  if (end) {
    filters.push("date(created_at) <= date(?)");
    params.push(end);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return db.prepare(`
    SELECT id, user_login AS login, user_name AS name, role, event_type AS eventType, created_at AS date
    FROM time_clock
    ${where}
    ORDER BY id DESC
    LIMIT 200
  `).all(...params);
}

function createTimeClock(payload, session) {
  const eventType = payload.eventType;
  if (!["entrada", "saida"].includes(eventType)) throw httpError(400, "Tipo de ponto inválido.");

  const last = db.prepare(`
    SELECT event_type AS eventType
    FROM time_clock
    WHERE user_login = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(session.login);

  if (last?.eventType === eventType) {
    const label = eventType === "entrada" ? "entrada" : "saída";
    throw httpError(400, `Último registro já foi uma ${label}.`);
  }

  const result = db.prepare(`
    INSERT INTO time_clock (user_login, user_name, role, event_type)
    VALUES (?, ?, ?, ?)
  `).run(session.login, session.name, session.role, eventType);

  return { ok: true, id: Number(result.lastInsertRowid), timeClock: listTimeClock(session) };
}

function saveUser(user) {
  validateUser(user);
  const cpf = onlyDigits(user.cpf);
  const login = user.login.trim();
  const existing = db.prepare("SELECT password_hash, salt FROM users WHERE cpf = ?").get(cpf);
  const loginOwner = db.prepare("SELECT cpf FROM users WHERE login = ?").get(login);

  if (loginOwner && loginOwner.cpf !== cpf) throw httpError(400, "Login já está em uso por outro usuário.");

  const credentials = user.password ? hashPassword(user.password) : existing;
  if (!credentials) throw httpError(400, "Senha obrigatória para novo usuário.");

  db.prepare(`
    INSERT INTO users (cpf, name, login, password_hash, salt, email, phone, role, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cpf) DO UPDATE SET
      name = excluded.name,
      login = excluded.login,
      password_hash = excluded.password_hash,
      salt = excluded.salt,
      email = excluded.email,
      phone = excluded.phone,
      role = excluded.role,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    cpf,
    user.name.trim(),
    login,
    credentials.hash || credentials.password_hash,
    credentials.salt,
    user.email?.trim() || "",
    user.phone?.trim() || "",
    user.cargo
  );

  return { ok: true };
}

function deleteUser(cpfValue) {
  const cpf = onlyDigits(cpfValue);
  const usersCount = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
  if (usersCount <= 1) throw httpError(400, "Mantenha ao menos um usuário.");

  const user = db.prepare("SELECT login FROM users WHERE cpf = ?").get(cpf);
  if (!user) throw httpError(404, "Usuário não encontrado.");

  const hasSales = db.prepare("SELECT COUNT(*) AS total FROM sales WHERE operator_login = ?").get(user.login).total;
  if (hasSales > 0) throw httpError(400, "Usuário já registrou vendas e não pode ser excluído.");

  db.prepare("DELETE FROM users WHERE cpf = ?").run(cpf);
}

function listSales(searchParams = new URLSearchParams()) {
  const { where, params } = salesFilters(searchParams);
  const sales = db.prepare(`
    SELECT id, operator_login AS operator, subtotal_cents AS subtotalCents,
      discount_cents AS discountCents, total_cents AS totalCents, created_at AS date
    FROM sales
    ${where}
    ORDER BY id DESC
    LIMIT 200
  `).all(...params);

  const itemsQuery = db.prepare(`
    SELECT product_code AS code, product_name AS name, quantity, cost_cents AS costCents,
      unit_price_cents AS unitPriceCents, discount_cents AS discountCents, total_cents AS totalCents
    FROM sale_items
    WHERE sale_id = ?
  `);

  return sales.map((sale) => ({ ...sale, items: itemsQuery.all(sale.id) }));
}

function salesFilters(searchParams) {
  const filters = [];
  const params = [];
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const operator = searchParams.get("operator");
  const product = searchParams.get("product");

  if (start) {
    filters.push("date(created_at) >= date(?)");
    params.push(start);
  }
  if (end) {
    filters.push("date(created_at) <= date(?)");
    params.push(end);
  }
  if (operator) {
    filters.push("operator_login = ?");
    params.push(operator);
  }
  if (product) {
    filters.push(`id IN (
      SELECT sale_id FROM sale_items
      WHERE product_code LIKE ? OR product_name LIKE ?
    )`);
    params.push(`%${product}%`, `%${product}%`);
  }

  return {
    where: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params
  };
}

function createSale(payload, session) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const saleDiscountCents = Math.max(0, Number(payload.discountCents) || 0);
  if (!items.length) throw httpError(400, "Adicione itens antes de registrar.");

  try {
    db.exec("BEGIN IMMEDIATE");
    let subtotal = 0;
    const normalizedItems = items.map((item) => {
      const product = db.prepare("SELECT * FROM products WHERE code = ?").get(String(item.code || ""));
      const quantity = Number(item.quantity);
      const discountCents = Math.max(0, Number(item.discountCents) || 0);

      if (!product) throw httpError(400, `Produto ${item.code} não encontrado.`);
      if (!Number.isInteger(quantity) || quantity <= 0) throw httpError(400, "Quantidade inválida.");
      if (quantity > product.quantity) throw httpError(400, `Estoque insuficiente para ${product.name}.`);

      const gross = quantity * product.price_cents;
      if (discountCents > gross) throw httpError(400, `Desconto maior que o item ${product.name}.`);

      const itemTotal = gross - discountCents;
      subtotal += itemTotal;
      return { product, quantity, discountCents, total: itemTotal };
    });

    if (saleDiscountCents > subtotal) throw httpError(400, "Desconto maior que o subtotal.");

    const total = subtotal - saleDiscountCents;
    const sale = db.prepare(`
      INSERT INTO sales (operator_login, subtotal_cents, discount_cents, total_cents)
      VALUES (?, ?, ?, ?)
    `).run(session.login, subtotal, saleDiscountCents, total);

    for (const item of normalizedItems) {
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_code, product_name, quantity, cost_cents, unit_price_cents, discount_cents, total_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sale.lastInsertRowid,
        item.product.code,
        item.product.name,
        item.quantity,
        item.product.cost_cents,
        item.product.price_cents,
        item.discountCents,
        item.total
      );
      db.prepare("UPDATE products SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?")
        .run(item.quantity, item.product.code);
    }

    db.exec("COMMIT");
    return { ok: true, id: Number(sale.lastInsertRowid), subtotalCents: subtotal, discountCents: saleDiscountCents, totalCents: total };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function buildReports() {
  const byDay = db.prepare(`
    SELECT date(created_at) AS date, COUNT(*) AS salesCount,
      SUM(total_cents) AS revenueCents, SUM(discount_cents) AS discountCents
    FROM sales
    GROUP BY date(created_at)
    ORDER BY date DESC
    LIMIT 30
  `).all();

  const topProducts = db.prepare(`
    SELECT product_code AS code, product_name AS name, SUM(quantity) AS quantity,
      SUM(total_cents) AS revenueCents,
      SUM((unit_price_cents - cost_cents) * quantity - discount_cents) AS profitCents
    FROM sale_items
    GROUP BY product_code, product_name
    ORDER BY quantity DESC, revenueCents DESC
    LIMIT 10
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(*) AS salesCount, COALESCE(SUM(total_cents), 0) AS revenueCents,
      COALESCE(SUM(discount_cents), 0) AS discountCents
    FROM sales
  `).get();

  const profit = db.prepare(`
    SELECT COALESCE(SUM((unit_price_cents - cost_cents) * quantity - discount_cents), 0) AS profitCents
    FROM sale_items
  `).get();

  return { ...totals, profitCents: profit.profitCents, byDay, topProducts };
}

function validateProduct(product) {
  const quantity = Number(product?.quantity);
  const minStock = Number(product?.minStock);
  const costCents = Number(product?.costCents);
  const priceCents = Number(product?.priceCents);

  if (!product?.code?.trim() || !product?.name?.trim()) throw httpError(400, "Código e produto são obrigatórios.");
  if (!["Higiene", "Utensílio", "Maquiagem", "Alimento"].includes(normalizeCategory(product.category))) {
    throw httpError(400, "Categoria inválida.");
  }
  if (!Number.isInteger(quantity) || quantity < 0) throw httpError(400, "Quantidade inválida.");
  if (!Number.isInteger(minStock) || minStock < 0) throw httpError(400, "Estoque mínimo inválido.");
  if (!Number.isInteger(costCents) || !Number.isInteger(priceCents) || costCents < 0 || priceCents < 0) {
    throw httpError(400, "Valores inválidos.");
  }
  if (priceCents < costCents) throw httpError(400, "Preço de venda deve ser maior ou igual ao custo.");
}

function validateUser(user) {
  const cpf = onlyDigits(user?.cpf || "");
  const email = user?.email?.trim() || "";

  if (!cpf || !user?.name?.trim() || !user?.login?.trim()) {
    throw httpError(400, "CPF, nome e login são obrigatórios.");
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Email inválido.");
  if (!roles.includes(user.cargo)) throw httpError(400, "Cargo inválido.");
}

function migrateDatabase() {
  migrateUsersTable();
  migrateTimeClockTable();
  addColumn("products", "min_stock", "INTEGER NOT NULL DEFAULT 5 CHECK (min_stock >= 0)");
  addColumn("sales", "subtotal_cents", "INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0)");
  addColumn("sales", "discount_cents", "INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0)");
  addColumn("sale_items", "cost_cents", "INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0)");
  addColumn("sale_items", "discount_cents", "INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0)");
  db.prepare("UPDATE sales SET subtotal_cents = total_cents WHERE subtotal_cents = 0").run();
  db.prepare("UPDATE products SET category = 'Utensílio' WHERE category = 'Utensilio'").run();
  db.prepare("UPDATE users SET role = 'Atendente balcão' WHERE role = 'Atendente'").run();
  db.prepare("UPDATE users SET cpf = '52998224725' WHERE cpf = '00000000000'").run();
  db.prepare("UPDATE users SET cpf = '39053344705' WHERE cpf = '11111111111'").run();
}

function migrateTimeClockTable() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'time_clock'").get()?.sql || "";
  if (!sql.includes("users_old")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    ALTER TABLE time_clock RENAME TO time_clock_old;
    CREATE TABLE time_clock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_login TEXT NOT NULL,
      user_name TEXT NOT NULL,
      role TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('entrada', 'saida')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_login) REFERENCES users(login)
    );
    INSERT INTO time_clock (id, user_login, user_name, role, event_type, created_at)
    SELECT id, user_login, user_name, role, event_type, created_at
    FROM time_clock_old;
    DROP TABLE time_clock_old;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

function migrateUsersTable() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || "";
  if (!sql.includes("CHECK (role IN")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    ALTER TABLE users RENAME TO users_old;
    CREATE TABLE users (
      cpf TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (cpf, name, login, password_hash, salt, email, phone, role, created_at, updated_at)
    SELECT cpf, name, login, password_hash, salt, email, phone,
      CASE WHEN role = 'Atendente' THEN 'Atendente balcão' ELSE role END,
      created_at, updated_at
    FROM users_old;
    DROP TABLE users_old;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seedDatabase() {
  ensureUser("00000000001", "Administrador Demo", "adm", "adm123", "adm@lojinha.local", "Adm");
  ensureUser("00000000000", "Supervisor Demo", "supervisor", "supervisor123", "supervisor@lojinha.local", "Supervisor");
  ensureUser("11111111111", "Atendente Demo", "atendente", "atendente123", "atendente@lojinha.local", "Atendente balcão");

  const productCount = db.prepare("SELECT COUNT(*) AS total FROM products").get().total;
  if (productCount === 0) {
    const insert = db.prepare(`
      INSERT INTO products (code, name, category, quantity, min_stock, cost_cents, price_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("001", "Sabonete", "Higiene", 24, 5, 210, 350);
    insert.run("002", "Panela pequena", "Utensílio", 6, 3, 3200, 4990);
    insert.run("003", "Arroz 5kg", "Alimento", 14, 5, 2150, 2990);
  }
}

function ensureUser(cpf, name, login, password, email, role) {
  const exists = db.prepare("SELECT login FROM users WHERE login = ?").get(login);
  if (exists) return;

  const credentials = hashPassword(password);
  db.prepare(`
    INSERT INTO users (cpf, name, login, password_hash, salt, email, phone, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cpf, name, login, credentials.hash, credentials.salt, email, "", role);
}

function normalizeCategory(category) {
  return category === "Utensilio" ? "Utensílio" : category;
}

function onlyDigits(value) {
  return String(value).replace(/\D/g, "");
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = expectedHash.length === 64
    ? createHash("sha256").update(`${salt}:${password}`).digest()
    : scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

function getSession(request) {
  const token = getBearerToken(request);
  return token ? sessions.get(token) : null;
}

function getBearerToken(request) {
  const authorization = request.headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function publicUser(user) {
  return {
    cpf: user.cpf,
    name: user.name,
    login: user.login,
    email: user.email,
    phone: user.phone,
    cargo: user.role
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
