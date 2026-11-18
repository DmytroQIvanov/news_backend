"""Pure registry metadata projection, shared by enrichment and encyclopedia consumers."""
from __future__ import annotations


def class_tags(values: list) -> list[dict[str, str]]:
    """Retain any observed Wikidata class, rather than limiting it to the entity-kind map."""
    qids = [value for value in values if isinstance(value, str) and value.startswith("Q") and value[1:].isdigit()]
    return [{"id": qid} for qid in dict.fromkeys(qids[:12])]


def enrichment_attributes(info: dict) -> dict:
    """Partial metadata must not erase an existing translation or unprovided class information."""
    attributes = {}
    if isinstance(info.get("wikidata_classes"), list):
        attributes["wikidata_classes"] = info["wikidata_classes"][:12]
    if info.get("description_uk"):
        attributes["description_uk"] = info["description_uk"]
    return attributes
