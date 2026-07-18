package model

import (
	"strings"
	"testing"
)

func TestEnterpriseShareAssetLinksExposeOnlyDocumentAssets(t *testing.T) {
	assetID := enterpriseShareAssetID(
		"20990718010000-sharebox",
		"20990718010001-sharedoc",
		"assets/diagram.png",
	)
	rendered, err := rewriteEnterpriseSharedAssetLinks(
		`<p><img src="/assets/diagram.png"><a href="assets/private.pdf">private</a><span data-x="1">ok</span></p>`,
		map[string]string{"assets/diagram.png": assetID},
	)
	if err != nil {
		t.Fatalf("rewrite shared asset links: %v", err)
	}
	if !strings.Contains(rendered, "singularity-share-asset:"+assetID) {
		t.Fatalf("rewritten document = %s", rendered)
	}
	if strings.Contains(rendered, "private.pdf") || strings.Contains(rendered, "src=\"/assets/diagram.png\"") {
		t.Fatalf("document exposed an unbound asset link: %s", rendered)
	}
}

func TestEnterpriseShareAssetIdentityAndDispositionAreStable(t *testing.T) {
	first := enterpriseShareAssetID(
		"20990718010000-sharebox",
		"20990718010001-sharedoc",
		"assets/diagram.png",
	)
	if first != enterpriseShareAssetID(
		"20990718010000-sharebox",
		"20990718010001-sharedoc",
		"assets/diagram.png",
	) {
		t.Fatal("shared asset identity is not deterministic")
	}
	if first == enterpriseShareAssetID(
		"20990718010000-sharebox",
		"20990718010001-sharedoc",
		"assets/other.png",
	) {
		t.Fatal("different asset paths share an identity")
	}
	for _, mediaType := range []string{"image/png", "audio/ogg", "video/webm"} {
		if !enterpriseShareInlineMediaType(mediaType) {
			t.Fatalf("%s was not allowed inline", mediaType)
		}
	}
	for _, mediaType := range []string{"text/html", "application/pdf", "image/svg+xml"} {
		if enterpriseShareInlineMediaType(mediaType) {
			t.Fatalf("%s was allowed inline", mediaType)
		}
	}
}
