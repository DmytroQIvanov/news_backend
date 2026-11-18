"""Pure encyclopedia enrichment tests: standard library only, no HTTP/DB dependencies."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from kb.encyclopedia_metadata import class_tags, enrichment_attributes


class EncyclopediaEnrichmentTests(unittest.TestCase):
    def test_unknown_wikidata_classes_are_preserved_without_a_kind_allowlist(self):
        self.assertEqual(class_tags(["Q987654321", "Q5"]), [{"id": "Q987654321"}, {"id": "Q5"}])
        self.assertEqual(class_tags([None, {}, 12, "not-a-class", "Qinvalid"]), [])
        self.assertLessEqual(len(class_tags([f"Q{i}" for i in range(50)])), 12)

    def test_existing_entity_gets_classes_and_ukrainian_description(self):
        result = enrichment_attributes({"wikidata_classes": [{"id": "Q987654321"}], "description_uk": "Опис сутності"})
        self.assertEqual(result, {"wikidata_classes": [{"id": "Q987654321"}], "description_uk": "Опис сутності"})

    def test_missing_fields_do_not_erase_existing_metadata(self):
        self.assertEqual(enrichment_attributes({"description_uk": None}), {})
        self.assertEqual(enrichment_attributes({"wikidata_classes": None}), {})
        self.assertEqual(enrichment_attributes({"wikidata_classes": []}), {"wikidata_classes": []})


if __name__ == "__main__":
    unittest.main()
