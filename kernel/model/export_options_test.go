package model

import (
	"errors"
	"strings"
	"testing"

	kernelconf "github.com/siyuan-note/siyuan/kernel/conf"
)

func TestExportOptionsRemainRequestScoped(t *testing.T) {
	previous := Conf
	Conf = NewAppConf()
	Conf.Export = kernelconf.NewExport()
	t.Cleanup(func() { Conf = previous })

	addTitle := false
	includeRelated := true
	first := effectiveExportConfig(&ExportOptions{
		AddTitle:           &addTitle,
		IncludeRelatedDocs: &includeRelated,
	})
	second := effectiveExportConfig(nil)

	if first.AddTitle || !first.IncludeRelatedDocs {
		t.Fatalf("request options were not applied to the request snapshot: %#v", first)
	}
	if !second.AddTitle || second.IncludeRelatedDocs {
		t.Fatalf("request options leaked into a later export snapshot: %#v", second)
	}
	if !Conf.Export.AddTitle || Conf.Export.IncludeRelatedDocs {
		t.Fatalf("request options mutated the persisted export config: %#v", Conf.Export)
	}
}

func TestExportMarkdownContentRoutesDuplicateBlockIDByNotebook(t *testing.T) {
	fixture := setupHeadingNotebookFixture(t)
	Conf.Export = kernelconf.NewExport()
	Conf.Editor = kernelconf.NewEditor()

	_, ordinary, ordinaryErr := ExportMarkdownContentInBox(
		fixture.headingID, 3, 1, false, false, false, false, false, fixture.ordinaryBox,
	)
	_, encrypted, encryptedErr := ExportMarkdownContentInBox(
		fixture.headingID, 3, 1, false, false, false, false, false, fixture.encryptedBox,
	)
	_, mismatched, mismatchErr := ExportMarkdownContentInBox(
		fixture.headingID, 3, 1, false, false, false, false, false, fixture.otherOrdinaryBox,
	)

	if ordinaryErr != nil {
		t.Fatalf("ordinary export failed: %v", ordinaryErr)
	}
	if !strings.Contains(ordinary, "Ordinary child") || strings.Contains(ordinary, "Encrypted child") {
		t.Fatalf("ordinary export crossed content stores: %s", ordinary)
	}
	if encryptedErr != nil {
		t.Fatalf("encrypted export failed: %v", encryptedErr)
	}
	if !strings.Contains(encrypted, "Encrypted child") || strings.Contains(encrypted, "Ordinary child") {
		t.Fatalf("encrypted export crossed content stores: %s", encrypted)
	}
	if !errors.Is(mismatchErr, ErrBlockNotFound) || mismatched != "" {
		t.Fatalf("mismatched notebook export = %q, %v; want ErrBlockNotFound without content", mismatched, mismatchErr)
	}
}
