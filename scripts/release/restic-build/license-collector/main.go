// Internal evidence collector. This is not a production release gate.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/mod/module"
	"golang.org/x/mod/sumdb/dirhash"
	modzip "golang.org/x/mod/zip"
)

const maxLicense = 1 << 20
const maxTotal = 128 << 20
const maxArchiveInput = uint64(4 << 30)

var licenseName = regexp.MustCompile(`(?i)^(license|licence|copying|notice|copyright)([._-].*)?$`)

type component struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	PURL    string `json:"purl"`
}
type sbom struct {
	Components []component `json:"components"`
}
type evidence struct {
	Module   string `json:"module"`
	Version  string `json:"version"`
	ModuleH1 string `json:"module_h1"`
	Path     string `json:"path"`
	SHA256   string `json:"sha256"`
	Content  string `json:"content"`
}
type result struct {
	BinarySHA256 string     `json:"binary_sha256"`
	GoVersion    string     `json:"go_version"`
	Arch         string     `json:"arch"`
	Modules      int        `json:"modules"`
	Licenses     []evidence `json:"licenses"`
}

func safeZipPath(root, rel string) (string, error) {
	p := filepath.Join(root, rel)
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	r, err := filepath.Rel(root, resolved)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(os.PathSeparator)) || filepath.IsAbs(r) {
		return "", errors.New("module cache path escapes root")
	}
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return "", errors.New("module cache member is not a regular file")
	}
	return resolved, nil
}

func purlIdentity(purl string) (string, string, error) {
	const prefix = "pkg:golang/"
	if !strings.HasPrefix(purl, prefix) || strings.Count(purl, "#") > 1 || strings.Contains(purl, "?") {
		return "", "", errors.New("invalid Go PURL")
	}
	locator, fragment, hasFragment := strings.Cut(strings.TrimPrefix(purl, prefix), "#")
	at := strings.LastIndex(locator, "@")
	if at <= 0 || at == len(locator)-1 || (hasFragment && fragment == "") {
		return "", "", errors.New("invalid Go PURL")
	}
	name, e1 := url.PathUnescape(locator[:at])
	version, e2 := url.PathUnescape(locator[at+1:])
	if hasFragment {
		part, e3 := url.PathUnescape(fragment)
		if e3 != nil || part == "" || strings.HasPrefix(part, "/") || strings.HasSuffix(part, "/") {
			return "", "", errors.New("invalid Go PURL fragment")
		}
		name += "/" + part
	}
	if e1 != nil || e2 != nil || name == "" || version == "" {
		return "", "", errors.New("invalid Go PURL")
	}
	return name, version, nil
}

func collect(binary, sbomPath, cacheRoot, goRoot, arch string) (result, error) {
	var out result
	expectedBinary := map[string]string{
		"arm64": "26c5b4d898ef5ea434d638fcbab616c319761dbd71ffe0d3585b37a9af62a2e1",
		"amd64": "2f516a8aebbc0510806a501a88efdca5f199e52f9c6b720f044157a25684d84e",
	}[arch]
	stat, err := os.Stat(binary)
	if expectedBinary == "" || err != nil || !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > 128<<20 {
		return out, errors.New("binary size or architecture is invalid")
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		return out, errors.New("cannot read binary")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != expectedBinary {
		return out, errors.New("binary does not match the verified build artifact")
	}
	bi, err := buildinfo.Read(bytes.NewReader(data))
	if err != nil {
		return out, errors.New("cannot read binary build information")
	}
	if bi.GoVersion != "go1.27.3" || bi.Main.Path != "github.com/restic/restic" || bi.Main.Version != "v0.19.1-aikayun.2" || bi.Main.Sum != "h1:ggpCj/YgpsldS+98NxKjYkSCT0d6F+pUnuSJDAlU65g=" || bi.Main.Replace != nil {
		return out, errors.New("unexpected toolchain or main module")
	}
	goos, goarch := "", ""
	for _, setting := range bi.Settings {
		if setting.Key == "GOOS" {
			goos = setting.Value
		}
		if setting.Key == "GOARCH" {
			goarch = setting.Value
		}
	}
	if goos != "linux" || goarch != arch || (arch != "arm64" && arch != "amd64") {
		return out, errors.New("unexpected binary platform")
	}
	mods := append([]*debug.Module{&bi.Main}, bi.Deps...)
	if len(mods) == 0 || len(mods) > 256 {
		return out, errors.New("binary module count exceeds limit")
	}
	want := make(map[string]string, len(mods))
	for _, m := range mods {
		if m == nil || m.Replace != nil || !strings.HasPrefix(m.Sum, "h1:") || module.Check(m.Path, m.Version) != nil {
			return out, errors.New("invalid or replaced module in binary")
		}
		key := m.Path + "@" + m.Version
		if _, exists := want[key]; exists {
			return out, errors.New("duplicate binary module")
		}
		want[key] = m.Sum
	}
	stat, err = os.Stat(sbomPath)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > 16<<20 {
		return out, errors.New("SBOM size exceeds limit")
	}
	contents, err := os.ReadFile(sbomPath)
	if err != nil {
		return out, errors.New("cannot read SBOM")
	}
	var sb sbom
	if json.Unmarshal(contents, &sb) != nil {
		return out, errors.New("invalid SBOM")
	}
	seen := make(map[string]bool)
	stdlib := false
	for _, c := range sb.Components {
		if !strings.HasPrefix(c.PURL, "pkg:golang/") {
			continue
		}
		purlName, purlVersion, err := purlIdentity(c.PURL)
		if err != nil || purlName != c.Name {
			return out, errors.New("SBOM PURL differs from component")
		}
		if c.Name == "stdlib" {
			if stdlib || c.Version != bi.GoVersion || purlVersion != strings.TrimPrefix(bi.GoVersion, "go") {
				return out, errors.New("unexpected Go standard library")
			}
			stdlib = true
			continue
		}
		if purlVersion != c.Version {
			return out, errors.New("SBOM PURL differs from component")
		}
		key := c.Name + "@" + c.Version
		if seen[key] || want[key] == "" {
			return out, errors.New("SBOM module differs from binary")
		}
		seen[key] = true
	}
	if !stdlib || len(seen) != len(want) {
		return out, errors.New("SBOM is missing binary modules")
	}
	root, err := filepath.EvalSymlinks(cacheRoot)
	if err != nil {
		return out, errors.New("cannot resolve module cache")
	}
	keys := make([]string, 0, len(want))
	for k := range want {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	total := 0
	var archiveInput uint64
	for _, key := range keys {
		at := strings.LastIndex(key, "@")
		mod, ver := key[:at], key[at+1:]
		ep, e1 := module.EscapePath(mod)
		ev, e2 := module.EscapeVersion(ver)
		if e1 != nil || e2 != nil {
			return out, errors.New("invalid module cache name")
		}
		rel := filepath.Join("cache", "download", ep, "@v", ev+".zip")
		archive, err := safeZipPath(root, rel)
		if err != nil {
			return out, errors.New("module ZIP missing or unsafe")
		}
		archiveStat, err := os.Stat(archive)
		if err != nil || archiveStat.Size() <= 0 || archiveStat.Size() > 128<<20 {
			return out, errors.New("module ZIP size exceeds limit")
		}
		sumfile, err := safeZipPath(root, rel+"hash")
		if err != nil {
			return out, errors.New("module ZIP hash missing or unsafe")
		}
		sumStat, err := os.Stat(sumfile)
		if err != nil || sumStat.Size() <= 0 || sumStat.Size() > 256 {
			return out, errors.New("cached ZIP hash size exceeds limit")
		}
		stored, err := os.ReadFile(sumfile)
		if err != nil || strings.TrimSpace(string(stored)) != want[key] {
			return out, errors.New("cached ZIP hash differs from binary")
		}
		if _, err = modzip.CheckZip(module.Version{Path: mod, Version: ver}, archive); err != nil {
			return out, errors.New("module ZIP failed Go path validation")
		}
		z, err := zip.OpenReader(archive)
		if err != nil {
			return out, errors.New("cannot open module ZIP")
		}
		if len(z.File) > 100000 {
			z.Close()
			return out, errors.New("module ZIP has too many files")
		}
		for _, f := range z.File {
			if f.Mode()&os.ModeSymlink != 0 || f.UncompressedSize64 > maxArchiveInput-archiveInput {
				z.Close()
				return out, errors.New("unsafe or oversized module ZIP")
			}
			archiveInput += f.UncompressedSize64
		}
		actual, err := dirhash.HashZip(archive, dirhash.Hash1)
		if err != nil || actual != want[key] {
			z.Close()
			return out, errors.New("module ZIP content differs from binary")
		}
		n := 0
		for _, f := range z.File {
			if f.FileInfo().IsDir() || !licenseName.MatchString(path.Base(f.Name)) {
				continue
			}
			if f.UncompressedSize64 == 0 || f.UncompressedSize64 > maxLicense {
				z.Close()
				return out, errors.New("empty or oversized license")
			}
			reader, err := f.Open()
			if err != nil {
				z.Close()
				return out, errors.New("cannot open license")
			}
			data, err := io.ReadAll(io.LimitReader(reader, maxLicense+1))
			closeErr := reader.Close()
			if err != nil || closeErr != nil || len(data) == 0 || len(data) > maxLicense || !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
				z.Close()
				return out, errors.New("invalid license content")
			}
			total += len(data)
			if total > maxTotal {
				z.Close()
				return out, errors.New("license collection exceeds limit")
			}
			sum := sha256.Sum256(data)
			out.Licenses = append(out.Licenses, evidence{mod, ver, want[key], f.Name, hex.EncodeToString(sum[:]), string(data)})
			n++
		}
		z.Close()
		if n == 0 {
			return out, errors.New("module has no license evidence")
		}
	}
	// Conservatively include every matching license in the pinned Go toolchain
	// image, including nested third-party terms, rather than infer applicability.
	goVersion, err := os.ReadFile(filepath.Join(goRoot, "VERSION"))
	if err != nil || !strings.HasPrefix(string(goVersion), bi.GoVersion+"\n") {
		return out, errors.New("unexpected Go source version")
	}
	goLicense, err := os.ReadFile(filepath.Join(goRoot, "LICENSE"))
	goLicenseHash := sha256.Sum256(goLicense)
	if err != nil || hex.EncodeToString(goLicenseHash[:]) != "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad" {
		return out, errors.New("unexpected Go license")
	}
	goFiles := 0
	goEntries := 0
	err = filepath.WalkDir(goRoot, func(p string, entry os.DirEntry, walkErr error) error {
		goEntries++
		if goEntries > 1000000 || len(p) > 4096 {
			return errors.New("Go source tree exceeds limit")
		}
		if walkErr != nil || entry.Type()&os.ModeSymlink != 0 {
			return errors.New("unsafe Go source path")
		}
		if entry.IsDir() || !licenseName.MatchString(entry.Name()) {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxLicense {
			return errors.New("invalid Go license file")
		}
		content, err := os.ReadFile(p)
		if err != nil || len(content) == 0 || len(content) > maxLicense || !utf8.Valid(content) || bytes.ContainsRune(content, 0) {
			return errors.New("invalid Go license content")
		}
		total += len(content)
		if total > maxTotal {
			return errors.New("license collection exceeds limit")
		}
		rel, err := filepath.Rel(goRoot, p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return errors.New("unsafe Go license path")
		}
		sum := sha256.Sum256(content)
		out.Licenses = append(out.Licenses, evidence{"stdlib", bi.GoVersion, "", filepath.ToSlash(rel), hex.EncodeToString(sum[:]), string(content)})
		goFiles++
		return nil
	})
	if err != nil || goFiles == 0 {
		return out, errors.New("cannot collect Go license evidence")
	}
	out.BinarySHA256 = hex.EncodeToString(sum[:])
	out.GoVersion = bi.GoVersion
	out.Arch = arch
	out.Modules = len(want)
	return out, nil
}

func run(args []string) error {
	if len(args) != 6 {
		return errors.New("usage: collector BINARY SBOM MODULE_CACHE GO_ROOT ARCH NEW_PRIVATE_OUTPUT_DIR")
	}
	// The cache and binary must be mounted read-only, and the generated evidence
	// must be secret-scanned before it is included in any signed release.
	out, err := collect(args[0], args[1], args[2], args[3], args[4])
	if err != nil {
		return err
	}
	dest := args[5]
	if !filepath.IsAbs(dest) {
		return errors.New("output must be an absolute new directory")
	}
	if err = os.Mkdir(dest, 0700); err != nil {
		return errors.New("cannot create private output directory")
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(dest)
		}
	}()
	f, err := os.OpenFile(filepath.Join(dest, "license-evidence.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("cannot create private evidence")
	}
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	err = enc.Encode(out)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.New("cannot write evidence")
	}
	ok = true
	fmt.Printf("verified %d modules; collected %d license files\n", out.Modules, len(out.Licenses))
	return nil
}
func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "license evidence rejected:", err)
		os.Exit(1)
	}
}
