package model

import (
	"strings"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/util"
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

func TestEnterpriseShareProjectionDropsIdentityAndActiveContentMarkup(t *testing.T) {
	rendered, err := rewriteEnterpriseSharedAssetLinks(
		util.SanitizeHTML(
			`<div data-node-id="20260718010101-private"><svg><script>alert(1)</script></svg><p>正文</p></div>`,
		),
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("sanitize shared projection: %v", err)
	}
	if strings.Contains(rendered, "data-node-id") || strings.Contains(rendered, "<svg") || strings.Contains(rendered, "script") {
		t.Fatalf("shared projection retained private or active markup: %s", rendered)
	}
	if !strings.Contains(rendered, "正文") {
		t.Fatalf("shared projection lost document text: %s", rendered)
	}
}
