import express from "express";
import cors from "cors";
import morgan from "morgan";
import fetch from "node-fetch";
import pkg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pkg;
const app = express();

const {
  PORT = 3000,
  ELASTIC_URL = "http://elasticsearch:9200",
  RECOMMENDER_URL = "http://recommender:8000",
  DATABASE_URL,
  GITHUB_CLIENT_ID = "",
  GITHUB_CLIENT_SECRET = "",
  GITHUB_REDIRECT_URI = "http://localhost:3000/auth/github/callback",
  FRONTEND_ORIGIN = "http://localhost:3000",
} = process.env;

const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// Servir la SPA desde ../frontend
const publicPath = path.join(__dirname, "..", "public");
app.use(express.static(publicPath));

// Fallback: que GET / devuelva siempre index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

const pool = new Pool({ connectionString: DATABASE_URL });

/* ------------------------ HELPERS AUTENTICACIÓN ------------------------ */

function createJwt(user) {
  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

async function findUserByEmail(email) {
  const result = await pool.query(
    "SELECT id, email, name, password_hash FROM users WHERE email = $1",
    [email]
  );
  return result.rows[0] || null;
}

async function createSocialUser(email, name) {
  // Generamos una contraseña aleatoria solo para cumplir la NOT NULL
  const randomPassword = crypto.randomBytes(24).toString("hex");
  const passwordHash = await bcrypt.hash(randomPassword, 10);

  const result = await pool.query(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, email, name, created_at`,
    [email, name || null, passwordHash]
  );

  return result.rows[0];
}


/* ----------------------------- HEALTHCHECK ----------------------------- */

app.get("/api/health", async (_req, res) => {
  try {
    const db = await pool.query("select 1");
    const esOk = await fetch(`${ELASTIC_URL}`).then((r) => r.ok);
    const recOk = await fetch(`${RECOMMENDER_URL}/health`).then((r) => r.ok);
    res.json({
      ok: true,
      db: db.rowCount === 1,
      elastic: !!esOk,
      recommender: !!recOk,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------------- AUTH CLÁSICO ---------------------------- */

/**
 * Registro de usuario
 * POST /api/auth/register
 * body: { email, name, password }
 */
app.post("/api/auth/register", async (req, res) => {
  const { email, name, password } = req.body || {};

  if (!email || !password) {
    return res
      .status(400)
      .json({ ok: false, error: "Email y contraseña son obligatorios" });
  }

  try {
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ ok: false, error: "El email ya está registrado" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email, name || null, passwordHash]
    );

    const user = result.rows[0];
    const token = createJwt(user);
    res.status(201).json({ ok: true, user, token });
  } catch (err) {
    console.error("Error en /api/auth/register:", err);
    res.status(500).json({ ok: false, error: "Error en registro" });
  }
});

/**
 * Login de usuario
 * POST /api/auth/login
 * body: { email, password }
 */
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res
      .status(400)
      .json({ ok: false, error: "Email y contraseña son obligatorios" });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user || !user.password_hash) {
      return res
        .status(401)
        .json({ ok: false, error: "Credenciales inválidas" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ ok: false, error: "Credenciales inválidas" });
    }

    delete user.password_hash;
    const token = createJwt(user);
    res.json({ ok: true, user, token });
  } catch (err) {
    console.error("Error en /api/auth/login:", err);
    res.status(500).json({ ok: false, error: "Error en login" });
  }
});

/**
 * Recuperar usuario desde token
 * GET /api/auth/me   (Auth: Bearer <token>)
 */
app.get("/api/auth/me", (req, res) => {
  const auth = req.headers.authorization || "";
  const [, token] = auth.split(" ");

  if (!token) {
    return res.status(401).json({ ok: false, error: "No token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({
      ok: true,
      user: { id: payload.id, email: payload.email, name: payload.name },
    });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
});

/* --------------------------- AUTH GITHUB OAUTH -------------------------- */

/**
 * Redirigir al login de GitHub
 */
app.get("/auth/github/login", (_req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).send("GitHub OAuth no está configurado");
  }

  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope: "read:user user:email",
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

/**
 * Callback de GitHub
 */
app.get("/auth/github/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("GitHub token error:", tokenData);
      return res
        .status(500)
        .send("GitHub auth error: " + JSON.stringify(tokenData));
    }

    const ghToken = tokenData.access_token;

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        "User-Agent": "EuskoTrips-App",
      },
    });

    const ghUser = await userRes.json();

    const emailRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        "User-Agent": "EuskoTrips-App",
      },
    });

    const emails = await emailRes.json();
    const primaryEmail =
      (Array.isArray(emails) && emails.find((e) => e.primary)?.email) ||
      ghUser.email;

    if (!primaryEmail) {
      console.error("GitHub no devolvió email:", { ghUser, emails });
      return res
        .status(500)
        .send("No se pudo obtener el email de GitHub: " + JSON.stringify(ghUser));
    }

    let user = await findUserByEmail(primaryEmail);
    if (!user) {
      user = await createSocialUser(
        primaryEmail,
        ghUser.name || ghUser.login || null
      );
    } else {
      if (!user.name && (ghUser.name || ghUser.login)) {
        const updated = await pool.query(
          "UPDATE users SET name = $1 WHERE id = $2 RETURNING id, email, name",
          [ghUser.name || ghUser.login, user.id]
        );
        user = updated.rows[0];
      }
    }

    const jwtToken = createJwt(user);
    const redirectUrl = `${FRONTEND_ORIGIN}/?githubToken=${encodeURIComponent(
      jwtToken
    )}`;

    res.redirect(redirectUrl);
  } catch (err) {
    console.error("GitHub callback error:", err);
    res
      .status(500)
      .send("Error en el login con GitHub: " + String(err?.message || err));
  }
});

/* ----------------------- BÚSQUEDA / CATEGORÍAS ES ----------------------- */

/**
 * BÚSQUEDA DE DESTINOS
 */
app.get("/api/destinos", async (req, res) => {
  const {
    q,
    municipio,
    territorio,
    tipo_recurso,
    source_dataset,
    categoria,
    size = 10,
  } = req.query;

  const textParts = [];
  if (q && String(q).trim() !== "") textParts.push(String(q));
  if (municipio && String(municipio).trim() !== "")
    textParts.push(String(municipio));
  if (territorio && String(territorio).trim() !== "")
    textParts.push(String(territorio));

  const filters = [];

  if (tipo_recurso) {
    filters.push({ term: { tipo_recurso: String(tipo_recurso) } });
  }
  if (source_dataset) {
    filters.push({ term: { source_dataset: String(source_dataset) } });
  }
  if (categoria) {
    filters.push({ term: { categoria: String(categoria) } });
  }

  let esQuery;

  if (textParts.length === 0 && filters.length === 0) {
    esQuery = { match_all: {} };
  } else {
    const mustClause =
      textParts.length > 0
        ? [
            {
              multi_match: {
                query: textParts.join(" "),
                fields: [
                  "nombre^3",
                  "descripcion",
                  "municipio",
                  "territorio",
                  "tipo_recurso",
                  "source_dataset",
                  "categoria",
                  "raw_properties.*",
                ],
              },
            },
          ]
        : [{ match_all: {} }];

    esQuery = {
      bool: {
        must: mustClause,
        filter: filters,
      },
    };
  }

  const body = {
    query: esQuery,
    size: Number(size) || 10,
  };

  try {
    const r = await fetch(`${ELASTIC_URL}/destinos/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      console.error("Error ES search:", r.status, text);
      return res.status(500).json({ error: "Error en Elasticsearch" });
    }

    const data = await r.json();
    const hits =
      data.hits?.hits?.map((h) => ({
        id: h._id,
        score: h._score,
        ...h._source,
      })) ?? [];

    res.json(hits);
  } catch (err) {
    console.error("Error llamando a Elasticsearch:", err);
    res.status(500).json({ error: "Error llamando a Elasticsearch" });
  }
});

/**
 * OBTENER CATEGORÍAS (subtipos) DINÁMICAS
 */
app.get("/api/categorias", async (req, res) => {
  const { tipo_recurso } = req.query;

  const query = tipo_recurso
    ? { term: { tipo_recurso: String(tipo_recurso) } }
    : { match_all: {} };

  const body = {
    size: 0,
    query,
    aggs: {
      categorias: {
        terms: {
          field: "categoria",
          size: 50,
        },
      },
    },
  };

  try {
    const r = await fetch(`${ELASTIC_URL}/destinos/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      console.error("Error ES /api/categorias:", r.status, text);
      return res.status(500).json({ error: "Error en Elasticsearch" });
    }

    const data = await r.json();
    const buckets = data.aggregations?.categorias?.buckets ?? [];

    const categorias = buckets
      .map((b) => b.key)
      .filter((c) => c && c.trim() !== "")
      .sort((a, b) => a.localeCompare(b, "es"));

    res.json(categorias);
  } catch (err) {
    console.error("Error /api/categorias:", err);
    res.status(500).json({ error: "Error llamando a Elasticsearch" });
  }
});

/* ------------------------- RECOMMENDER PROXY ---------------------------- */

app.get("/api/recomendador/rank", async (req, res) => {
  try {
    const url = new URL("/rank", RECOMMENDER_URL);
    if (req.query.usuarioId) {
      url.searchParams.set("usuarioId", String(req.query.usuarioId));
    }

    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      console.error("Error llamando al recomendador:", r.status, text);
      return res
        .status(500)
        .json({ error: "Error llamando al microservicio recomendador" });
    }

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error("Error /api/recomendador/rank:", err);
    res
      .status(500)
      .json({ error: "Error interno al llamar al recomendador" });
  }
});

/* ------------------------------- FAVORITOS ------------------------------ */

/**
 * LISTAR favoritos de un usuario
 * GET /api/favoritos?userId=...
 */
app.get("/api/favoritos", async (req, res) => {
  const userId = String(req.query.userId || "");
  if (!userId) return res.status(400).json({ error: "Falta userId" });

  try {
    const result = await pool.query(
      "SELECT id, user_id, destino_id, created_at FROM favoritos WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error listando favoritos:", err);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

/**
 * FAVORITOS COMPLETOS (Postgres + Elasticsearch)
 * GET /api/favoritos/full?userId=...
 */
app.get("/api/favoritos/full", async (req, res) => {
  const userId = String(req.query.userId || "");
  if (!userId) return res.status(400).json({ error: "Falta userId" });

  try {
    const favsResult = await pool.query(
      "SELECT id, destino_id FROM favoritos WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    const favs = favsResult.rows;

    if (favs.length === 0) {
      return res.json([]);
    }

    const ids = favs.map((f) => f.destino_id);

    const esResp = await fetch(`${ELASTIC_URL}/destinos/_mget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });

    if (!esResp.ok) {
      const text = await esResp.text();
      console.error("Error ES _mget favoritos:", esResp.status, text);
      return res.status(500).json({ error: "Error en Elasticsearch" });
    }

    const esData = await esResp.json();
    const docs = esData.docs || [];

    const full = docs
      .filter((d) => d.found)
      .map((d) => {
        const favRow = favs.find((f) => f.destino_id === d._id);
        return {
          id: d._id,
          ...d._source,
          favorito_row_id: favRow?.id,
        };
      });

    res.json(full);
  } catch (err) {
    console.error("Error en /api/favoritos/full:", err);
    res
      .status(500)
      .json({ error: "Error interno cargando favoritos completos" });
  }
});

/**
 * AÑADIR un favorito
 * POST /api/favoritos
 * body: { userId, destinoId }
 */
app.post("/api/favoritos", async (req, res) => {
  const { userId, destinoId } = req.body || {};
  if (!userId || !destinoId) {
    return res.status(400).json({ error: "Faltan userId o destinoId" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO favoritos (user_id, destino_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, destino_id) DO NOTHING
       RETURNING id, user_id, destino_id, created_at`,
      [userId, destinoId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ alreadyExists: true });
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error añadiendo favorito:", err);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

/**
 * ELIMINAR un favorito
 * DELETE /api/favoritos/:id
 */
app.delete("/api/favoritos/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id inválido" });

  try {
    await pool.query("DELETE FROM favoritos WHERE id = $1", [id]);
    res.status(204).end();
  } catch (err) {
    console.error("Error eliminando favorito:", err);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

/* ------------------------------ ARRANQUE ------------------------------- */

app.listen(PORT, () => {
  console.log(`Gateway escuchando en http://localhost:${PORT}`);
});
