-- Store the full verdict object (verdict, summary, counts) so records round-trip exactly.
ALTER TABLE inspections ADD COLUMN verdict_json TEXT;
