"""Regenerate fixed canonical Bundle vectors using only Python's standard library.

Domain is deliberately restricted to ASCII below DEL in object keys/strings,
booleans, nulls, arrays, and safe integers. In this domain json.dumps with sorted keys
and compact separators agrees with the required UTF-8 JCS bytes; this is not
a general RFC 8785 serializer (notably for Unicode and noninteger numbers).
The seed is a schema-valid byte-free 0.1.0 document frozen in base-document.json.
These vectors exercise canonical projections, not complete Bundle verification.
"""

import copy
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def canonical(value):
    def check(item):
        if item is None or isinstance(item, bool):
            return
        if isinstance(item, int) and not isinstance(item, bool):
            assert abs(item) <= (2 ** 53 - 1)
            return
        if isinstance(item, str):
            assert all(ord(char) < 127 for char in item)
            return
        if isinstance(item, list):
            for child in item:
                check(child)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                assert isinstance(key, str)
                check(key)
                check(child)
            return
        raise AssertionError("outside restricted canonical vector domain")

    check(value)
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return text


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def seal_current(document):
    without_receipt = {key: value for key, value in document.items() if key != "receipt"}
    digest_input = {**without_receipt, "conservation": document["receipt"]["conservation"]}
    document["receipt"]["generatedSha256"] = digest(digest_input)
    return document


def envelope(document):
    entries = [{"id": asset["id"], "sha256": asset["sha256"],
                "mediaType": asset["mediaType"], "byteLength": 3,
                "payload": {"kind": "embedded", "base64": "AP+A"}}
               for asset in document["assets"]]
    return {"mediaType": "application/vnd.erniesg.struct+json",
            "bundleVersion": "1.0.0", "schemaVersion": document["schemaVersion"],
            "documentSha256": digest(document), "document": document,
            "assets": entries,
            "receipt": document["receipt"]}


def main():
    legacy = json.loads((HERE / "base-document.json").read_text())
    current = copy.deepcopy(legacy)
    current["schemaVersion"] = "0.2.0"
    current["documentId"] = "fixture-document"
    current["receipt"]["schemaVersion"] = "0.2.0"
    current["receipt"]["documentId"] = "fixture-document"
    seal_current(current)
    title = copy.deepcopy(current)
    title["metadata"]["title"] = "Fixture revised"
    seal_current(title)
    source = copy.deepcopy(current)
    source["source"]["sha256"] = "b" * 64
    source["receipt"]["sourceSha256"] = "b" * 64
    seal_current(source)

    vectors = []
    for name, document in [("legacy", legacy), ("current", current),
                           ("current-title", title), ("current-source-receipt", source)]:
        assert document["schemaVersion"] in ("0.1.0", "0.2.0")
        for label, value in [("document", document),
                             ("envelope", envelope(document))]:
            normalized = copy.deepcopy(value)
            if label == "envelope":
                normalized["assets"].sort(key=lambda asset: asset["id"])
            text = canonical(normalized)
            vectors.append({"name": name + ":" + label, "input": value,
                            "canonical": text,
                            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()})
    (HERE / "vectors.json").write_text(json.dumps(vectors, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
