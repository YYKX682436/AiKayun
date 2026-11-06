package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCachePathRejectsEscapeAndSymlinks(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "inside.zip")
	if err := os.WriteFile(inside, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := safeZipPath(root, "inside.zip"); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.zip")
	if err := os.WriteFile(outside, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link.zip")); err != nil {
		t.Fatal(err)
	}
	if _, err := safeZipPath(root, "link.zip"); err == nil {
		t.Fatal("accepted escaping symlink")
	}
	if _, err := safeZipPath(root, filepath.Join("..", filepath.Base(filepath.Dir(outside)), "outside.zip")); err == nil {
		t.Fatal("accepted escaping path")
	}
}

func TestRejectedInputsDoNotCreateEvidence(t *testing.T) {
	out := filepath.Join(t.TempDir(), "private-evidence")
	if err := run([]string{"/missing/binary", "/missing/sbom", "/missing/cache", "/missing/go", "arm64", out}); err == nil {
		t.Fatal("accepted a missing binary")
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatal("created output for rejected inputs")
	}
}

func TestLicenseNames(t *testing.T) {
	for _, name := range []string{"LICENSE", "LICENCE.txt", "NOTICE.md", "COPYING", "copyright"} {
		if !licenseName.MatchString(name) {
			t.Fatalf("missed %s", name)
		}
	}
	for _, name := range []string{"notes.txt", "LICENSES", "mylicense"} {
		if licenseName.MatchString(name) {
			t.Fatalf("unexpected %s", name)
		}
	}
}

func TestGoPURLIdentity(t *testing.T) {
	name, version, err := purlIdentity("pkg:golang/cloud.google.com/go/auth@v0.2.8#oauth2adapt")
	if err != nil || name != "cloud.google.com/go/auth/oauth2adapt" || version != "v0.2.8" {
		t.Fatal("did not resolve a Go submodule PURL")
	}
	for _, invalid := range []string{"pkg:golang/name", "pkg:golang/name@v1#", "pkg:golang/name@v1#x#y", "pkg:golang/name@v1?bad=1", "pkg:golang/name@v1#%zz"} {
		if _, _, err := purlIdentity(invalid); err == nil {
			t.Fatalf("accepted invalid PURL: %s", invalid)
		}
	}
}
