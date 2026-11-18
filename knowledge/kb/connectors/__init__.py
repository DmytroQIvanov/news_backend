"""Open-data connectors. Importing a module registers its connectors (see base.register)."""
import importlib
import logging

log = logging.getLogger(__name__)

MODULES = ["statistics", "gdelt", "sec", "eu", "nasdaq", "contracts", "science", "conflict", "sdmx", "prozorro", "ukraine"]


def load_all() -> None:
    for name in MODULES:
        try:
            importlib.import_module(f"{__name__}.{name}")
        except ModuleNotFoundError as exc:
            if exc.name and exc.name.endswith(name):
                continue  # module not written yet
            raise
