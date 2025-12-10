import os
from typing import List, Optional
from urllib.parse import urlparse

import httpx
import pg8000.dbapi as pg
from fastapi import FastAPI, HTTPException, Query

# ---------------------------------------------------------
# Configuración
# ---------------------------------------------------------
ELASTIC_URL = os.getenv("ELASTIC_URL", "http://elasticsearch:9200")
DATABASE_URL = os.getenv("DATABASE_URL")

app = FastAPI(
    title="EuskoTrips Recommender",
    version="1.0.0",
    description="Microservicio de recomendación basado en favoritos + Elasticsearch",
)


def get_db_connection():
    """Crea una conexión usando pg8000 a partir de DATABASE_URL."""
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL no está definida")

    # Esperamos algo tipo: postgres://user:pass@host:port/dbname
    url = urlparse(DATABASE_URL)

    return pg.connect(
        user=url.username,
        password=url.password,
        host=url.hostname,
        port=url.port or 5432,
        database=url.path.lstrip("/"),
    )


def check_db():
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1;")
        cur.fetchone()
    finally:
        conn.close()


# ---------------------------------------------------------
# Healthcheck
# ---------------------------------------------------------
@app.get("/health")
def health():
    try:
        # DB
        check_db()

        # ES
        r = httpx.get(ELASTIC_URL, timeout=3.0)
        es_ok = r.status_code == 200

        return {"ok": True, "db": True, "elastic": es_ok}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------
# Utilidades Elasticsearch
# ---------------------------------------------------------
def es_search_match_all(size: int = 50):
    body = {"query": {"match_all": {}}, "size": size}
    r = httpx.post(f"{ELASTIC_URL}/destinos/_search", json=body, timeout=8.0)
    r.raise_for_status()
    data = r.json()
    hits = data.get("hits", {}).get("hits", [])
    return hits


def es_mget_ids(ids: List[str]):
    if not ids:
        return []
    body = {"ids": ids}
    r = httpx.post(f"{ELASTIC_URL}/destinos/_mget", json=body, timeout=8.0)
    r.raise_for_status()
    data = r.json()
    return data.get("docs", [])


# ---------------------------------------------------------
# Lógica interna
# ---------------------------------------------------------
def get_user_favorites_ids(user_id: int) -> List[str]:
    """Obtiene los destino_id favoritos del usuario desde Postgres."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        # pg8000 usa el mismo estilo de placeholders %s que psycopg2
        cur.execute(
            "SELECT destino_id FROM favoritos WHERE user_id = %s",
            (user_id,),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    return [r[0] for r in rows]


def build_preference_profiles(fav_docs) -> dict:
    """
    A partir de los documentos favoritos, construimos un perfil de preferencias
    por categorías / municipio / territorio.
    """
    cats = set()
    munis = set()
    terrs = set()

    for d in fav_docs:
        src = d.get("_source", {})
        cat = src.get("categoria")
        if isinstance(cat, list):
            cats.update(cat)
        elif cat:
            cats.add(cat)

        mun = src.get("municipio")
        if mun:
            munis.add(mun)

        terr = src.get("territorio")
        if terr:
            terrs.add(terr)

    return {"categorias": cats, "municipios": munis, "territorios": terrs}


def score_candidate(doc, profile) -> float:
    """
    Score muy simple:
    - base: _score de ES (si existe)
    - +2 si coincide categoría con algún favorito
    - +1 si coincide municipio
    - +0.5 si coincide territorio
    """
    src = doc.get("_source", {})
    base_score = doc.get("_score", 1.0) or 1.0

    bonus = 0.0

    cat = src.get("categoria")
    fav_cats = profile["categorias"]
    if isinstance(cat, list):
        if fav_cats.intersection(cat):
            bonus += 2.0
    elif cat and cat in fav_cats:
        bonus += 2.0

    mun = src.get("municipio")
    if mun and mun in profile["municipios"]:
        bonus += 1.0

    terr = src.get("territorio")
    if terr and terr in profile["territorios"]:
        bonus += 0.5

    return base_score + bonus


# ---------------------------------------------------------
# Endpoint principal de ranking
# ---------------------------------------------------------
@app.get("/rank")
def rank(
    usuarioId: Optional[int] = Query(None, description="ID de usuario"),
    size: int = Query(10, ge=1, le=50),
):
    """
    Devuelve recomendaciones ordenadas.

    - Si no se pasa usuarioId -> resultados genéricos (match_all)
    - Si el usuario no tiene favoritos -> genéricos
    - Si tiene favoritos -> reordenados según similitud simple
    """
    try:
        # Sin usuario → genéricas
        if usuarioId is None:
            hits = es_search_match_all(size=size)
            results = [
                {
                    "id": h["_id"],
                    "score": h.get("_score", 1.0),
                    **h.get("_source", {}),
                }
                for h in hits
            ]
            return {"mode": "generic", "results": results}

        # Con usuario → mirar favoritos en DB
        fav_ids = get_user_favorites_ids(usuarioId)

        if not fav_ids:
            hits = es_search_match_all(size=size)
            results = [
                {
                    "id": h["_id"],
                    "score": h.get("_score", 1.0),
                    **h.get("_source", {}),
                }
                for h in hits
            ]
            return {"mode": "no_favorites", "results": results}

        # Docs de favoritos
        fav_docs = es_mget_ids(fav_ids)
        fav_docs = [d for d in fav_docs if d.get("found")]

        if not fav_docs:
            hits = es_search_match_all(size=size)
            results = [
                {
                    "id": h["_id"],
                    "score": h.get("_score", 1.0),
                    **h.get("_source", {}),
                }
                for h in hits
            ]
            return {"mode": "no_favorites_docs", "results": results}

        # Perfil de preferencias
        profile = build_preference_profiles(fav_docs)

        # Candidatos genéricos
        candidates = es_search_match_all(size=200)

        # ⚠️ NO recomendar elementos que ya son favoritos
        fav_ids_set = set(fav_ids)
        filtered_candidates = [c for c in candidates if c.get("_id") not in fav_ids_set]

        # Si al filtrar nos quedamos sin nada (por ejemplo pocos datos),
        # hacemos fallback a los candidatos originales.
        if not filtered_candidates:
            filtered_candidates = candidates

        scored = []
        for c in filtered_candidates:
            s = score_candidate(c, profile)
            scored.append(
                {
                    "id": c["_id"],
                    "score": s,
                    **c.get("_source", {}),
                }
            )

        scored.sort(key=lambda x: x["score"], reverse=True)
        results = scored[:size]

        return {
            "mode": "personalized",
            "user_id": usuarioId,
            "results": results,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
