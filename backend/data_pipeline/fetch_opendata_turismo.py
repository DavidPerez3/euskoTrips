import os
import json
from typing import List, Dict, Any

import requests

# -------------------------
# Configuración básica
# -------------------------

ELASTIC_URL = os.getenv("ELASTIC_URL", "http://localhost:9200")
INDEX = os.getenv("ES_INDEX", "destinos")

# Datasets de OpenData Euskadi que queremos cargar
# Todos en formato GeoJSON para tener coordenadas claras.
DATASETS = [
    {
        "name": "destinos_turisticos",
        "tipo_recurso": "destino",
        "url": "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/destinos_turisticos/opendata/destinos.geojson",
    },
    {
        "name": "rutas_y_paseos",
        "tipo_recurso": "ruta_paseo",
        "url": "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/rutas_paseos_euskadi/opendata/rutas.geojson",
    },
    {
        "name": "hoteles",
        "tipo_recurso": "alojamiento_hotel",
        "url": "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/hoteles_de_euskadi/opendata/alojamientos.geojson",
    },
    {
        "name": "restaurantes",
        "tipo_recurso": "restauracion",
        "url": "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/restaurantes_asador_sidrerias/opendata/restaurantes.geojson",
    },
]


# -------------------------
# Utilidades
# -------------------------

def get_json(url: str) -> Dict[str, Any]:
    print(f"→ Descargando GeoJSON: {url}")
    r = requests.get(url, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Error {r.status_code} al descargar {url}")
    return r.json()


def pick(props: Dict[str, Any], keys: List[str], default=None):
    """
    Devuelve el primer valor no vacío de props para cualquiera de las keys dadas.
    Es case-insensitive: prueba tal cual, en lower y en upper.
    """
    for k in keys:
        for candidate in {k, k.lower(), k.upper()}:
            if candidate in props and props[candidate]:
                return props[candidate]
    return default


def normalize_feature(
    feature: Dict[str, Any],
    dataset_name: str,
    tipo_recurso: str,
    idx: int,
) -> Dict[str, Any]:
    """
    Normaliza una feature GeoJSON de OpenData Euskadi a un documento
    cómodo para Elasticsearch.
    """
    props = feature.get("properties", {}) or {}
    geom = feature.get("geometry", {}) or {}
    coords = geom.get("coordinates") or []

    lon, lat = None, None
    if isinstance(coords, (list, tuple)) and len(coords) >= 2:
        lon, lat = coords[0], coords[1]

    # Nombre y descripción (documentname/documentdescription)
    nombre = pick(
        props,
        ["documentName", "documentname"],
    )
    descripcion = pick(
        props,
        ["documentDescription", "documentdescription"],
    )

    # Localización administrativa
    municipio = pick(
        props,
        ["municipio", "municipality", "locality"],
    )
    territorio = pick(
        props,
        ["territory", "territorio"],
    )
    pais = pick(
        props,
        ["country"],
    )

    # URL de ficha / web
    url_ficha = pick(
        props,
        ["friendlyurl", "physicalurl", "web"],
    )

    # Categoría / tipo de recurso
    categoria = pick(
        props,
        [
            "lodgingtype",      # hoteles
            "restorationtype",  # restaurantes
            "category",         # a veces alojamientos
            "type",             # rutas
            "templatetype",     # destinos / rutas
        ],
    )
    
    # Normalizar categoría:
    # - puede venir como "Cultura,Gastronomía,Naturaleza"
    # - o como "Naturaleza,0006"
    categorias_val = None

    if isinstance(categoria, str):
        # Separar por coma
        parts = [p.strip() for p in categoria.split(",") if p.strip()]

        # Quitar códigos tipo "0006" (solo dígitos)
        parts = [p for p in parts if not p.isdigit()]

        if len(parts) == 1:
            categorias_val = parts[0]        # string simple
        elif len(parts) > 1:
            categorias_val = parts           # lista de strings
        else:
            categorias_val = None
    else:
        categorias_val = categoria

    categoria = categorias_val

    # Fallbacks inteligentes
    if not nombre:
        # si no hay nombre, usamos municipio o territorio como título
        nombre = municipio or territorio or "Sin nombre"

    if descripcion == "" or descripcion is False:
        descripcion = None  # el front ya mostrará "Sin descripción disponible."

    # Intentamos construir un id estable
    raw_id = pick(
        props,
        ["id", "codigo", "code", "idRecurso", "idrecurso"],
        default=str(idx),
    )
    doc_id = f"{dataset_name}_{raw_id}"

    doc: Dict[str, Any] = {
        "id": doc_id,
        "nombre": nombre,
        "descripcion": descripcion,
        "municipio": municipio,
        "territorio": territorio,
        "pais": pais,
        "tipo_recurso": tipo_recurso,
        "source_dataset": dataset_name,
        "url_ficha": url_ficha,
        "categoria": categoria,
        # Guardamos crudo por si luego quieres explotar más campos
        "raw_properties": props,
    }

    if lat is not None and lon is not None:
        doc["location"] = {"lat": lat, "lon": lon}

    return doc


# -------------------------
# Elasticsearch helpers
# -------------------------

def ensure_index():
    """
    Crea el índice si no existe. Si ya existe, no hace nada.
    """
    print(f"Probando conexión a Elasticsearch en {ELASTIC_URL} ...")
    try:
        health = requests.get(f"{ELASTIC_URL}/_cluster/health", timeout=5)
        print("  Cluster health:", health.status_code, health.text[:120], "...")
    except Exception as e:
        print("  ⚠️ No se ha podido contactar con Elasticsearch:", e)

    head = requests.head(f"{ELASTIC_URL}/{INDEX}")
    if head.status_code == 200:
        print(f"Índice '{INDEX}' ya existe, no se recrea.")
        return

    print(f"Creando índice '{INDEX}' ...")
    body = {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "nombre": {
                    "type": "text",
                    "fields": {"keyword": {"type": "keyword"}},
                },
                "descripcion": {"type": "text"},
                "municipio": {"type": "keyword"},
                "territorio": {"type": "keyword"},
                "pais": {"type": "keyword"},
                "tipo_recurso": {"type": "keyword"},
                "source_dataset": {"type": "keyword"},
                "url_ficha": {"type": "keyword"},
                "categoria": {"type": "keyword"},
                "location": {"type": "geo_point"},
                # raw_properties lo dejamos como object
            }
        }
    }
    r = requests.put(f"{ELASTIC_URL}/{INDEX}", json=body)
    print("  Respuesta creación índice:", r.status_code, r.text[:200], "...")


def bulk_index(docs: List[Dict[str, Any]]):
    if not docs:
        print("No hay documentos para indexar.")
        return

    print(f"→ Indexando {len(docs)} documentos en '{INDEX}' ...")

    lines = []
    for doc in docs:
        meta = {"index": {"_index": INDEX, "_id": doc["id"]}}
        lines.append(json.dumps(meta, ensure_ascii=False))
        lines.append(json.dumps(doc, ensure_ascii=False))

    payload = "\n".join(lines) + "\n"

    r = requests.post(
        f"{ELASTIC_URL}/_bulk",
        data=payload.encode("utf-8"),
        headers={"Content-Type": "application/x-ndjson"},
    )

    print("  Bulk status:", r.status_code)
    if r.status_code >= 300:
        print("  Respuesta de error:", r.text[:500])
        r.raise_for_status()

    res = r.json()
    if res.get("errors"):
        print("⚠️ Hubo errores al indexar algunos documentos.")
    else:
        print("✅ Bulk completado sin errores.")


# -------------------------
# Main
# -------------------------

def main():
    ensure_index()

    all_docs: List[Dict[str, Any]] = []

    for ds in DATASETS:
        name = ds["name"]
        tipo = ds["tipo_recurso"]
        url = ds["url"]

        try:
            data = get_json(url)
        except Exception as e:
            print(f"⚠️ Error descargando dataset '{name}': {e}")
            continue

        features = data.get("features") or []
        print(f"  Dataset '{name}': {len(features)} features encontradas.")

        for i, feat in enumerate(features):
            doc = normalize_feature(feat, dataset_name=name, tipo_recurso=tipo, idx=i)
            all_docs.append(doc)

    print(f"Total documentos a indexar: {len(all_docs)}")
    bulk_index(all_docs)
    print("✅ Ingesta de OpenData Euskadi completada.")


if __name__ == "__main__":
    main()
