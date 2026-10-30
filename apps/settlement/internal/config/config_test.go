package config

import "testing"

func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoad_DatabaseURLRequired(t *testing.T) {
	withEnv(t, map[string]string{"DATABASE_URL": ""})
	if _, err := Load(); err == nil {
		t.Fatal("expected an error when DATABASE_URL is unset")
	}
}

func TestLoad_UsesDatabaseURLByDefault(t *testing.T) {
	withEnv(t, map[string]string{"DATABASE_URL": "postgres://a/db", "PGCONN_SETTLEMENT": ""})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://a/db" {
		t.Fatalf("expected DatabaseURL to be DATABASE_URL's value, got %q", cfg.DatabaseURL)
	}
}

// PGCONN_SETTLEMENT only applies when DATABASE_URL is unset (ARCHITECTURE,
// ops/README). Batch close writes, so it must never be silently re-pointed.
func TestLoad_DatabaseURLWinsOverPgconnSettlement(t *testing.T) {
	withEnv(t, map[string]string{
		"DATABASE_URL":      "postgres://a/db",
		"PGCONN_SETTLEMENT": "postgres://b/settlement-replica",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://a/db" {
		t.Fatalf("expected DATABASE_URL to win, got %q", cfg.DatabaseURL)
	}
}

func TestLoad_PgconnSettlementIsTheFallback(t *testing.T) {
	withEnv(t, map[string]string{"DATABASE_URL": "", "PGCONN_SETTLEMENT": "postgres://b/settlement"})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://b/settlement" {
		t.Fatalf("expected the PGCONN_SETTLEMENT fallback, got %q", cfg.DatabaseURL)
	}
}
