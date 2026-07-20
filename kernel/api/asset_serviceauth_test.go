package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/serviceauth"
	"github.com/siyuan-note/siyuan/kernel/treenode"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const (
	imageOCRServiceInstanceID = "11111111-1111-4111-8111-111111111111"
	imageOCRServiceSpaceID    = "22222222-2222-4222-8222-222222222222"
	imageOCRServiceRequestID  = "33333333-3333-4333-8333-333333333333"
	imageOCRServiceKeyID      = "ocr-contract-key"
)

func TestImageOCRServiceIdentityIsBoundToDocumentAsset(t *testing.T) {
	setupEncryptedResponseTest(t, 0)
	ownedBoxID, err := model.CreateBox("Owned OCR Notebook")
	if err != nil {
		t.Fatalf("create owned OCR notebook: %v", err)
	}
	otherBoxID, err := model.CreateBox("Other OCR Notebook")
	if err != nil {
		t.Fatalf("create other OCR notebook: %v", err)
	}
	const (
		documentID       = "20990720020101-ocrauth"
		fakeDocumentID   = "20990720020102-fakedoc"
		otherDocumentID  = "20990720020104-ocrothr"
		ownedAssetPath   = "assets/owned.png"
		unownedAssetPath = "assets/unowned.png"
		crossAssetPath   = "assets/cross.png"
		boundGlobalPath  = "assets/bound-global.png"
	)

	ownedAssetAbsPath := writeImageOCRAssetFixture(t, ownedBoxID, ownedAssetPath)
	unownedAssetAbsPath := writeImageOCRAssetFixture(t, ownedBoxID, unownedAssetPath)
	crossAssetAbsPath := writeImageOCRAssetFixture(t, otherBoxID, crossAssetPath)
	otherSameNameAbsPath := writeImageOCRAssetFixture(t, otherBoxID, ownedAssetPath)
	boundGlobalAbsPath := writeImageOCRAssetFixture(t, "", boundGlobalPath)
	createImageOCRDocumentFixture(t, ownedBoxID, documentID, []string{
		ownedAssetPath + "?box=" + ownedBoxID,
		crossAssetPath,
		boundGlobalPath + "?box=" + ownedBoxID,
	})
	createImageOCRDocumentFixture(t, otherBoxID, otherDocumentID, []string{ownedAssetPath})

	ownedKey := mustImageOCRAssetKey(t, ownedAssetAbsPath)
	unownedKey := mustImageOCRAssetKey(t, unownedAssetAbsPath)
	crossKey := mustImageOCRAssetKey(t, crossAssetAbsPath)
	otherSameNameKey := mustImageOCRAssetKey(t, otherSameNameAbsPath)
	boundGlobalKey := mustImageOCRAssetKey(t, boundGlobalAbsPath)
	util.SetAssetText(ownedKey, "owned OCR")
	util.SetAssetText(unownedKey, "unowned OCR")
	util.SetAssetText(crossKey, "cross OCR")
	util.SetAssetText(otherSameNameKey, "other notebook OCR")
	util.SetAssetText(boundGlobalKey, "global OCR")
	t.Cleanup(func() {
		util.RemoveAssetText(ownedKey)
		util.RemoveAssetText(unownedKey)
		util.RemoveAssetText(crossKey)
		util.RemoveAssetText(otherSameNameKey)
		util.RemoveAssetText(boundGlobalKey)
	})

	configuration, signingKey := newImageOCRServiceAuthConfiguration(t)
	router := imageOCRServiceAuthRouter(t, configuration)

	owned := serveAuthenticatedImageOCRRequest(t, router, signingKey, documentID, ownedBoxID, "/api/asset/getImageOCRText", map[string]any{
		"path": ownedAssetPath,
	})
	if owned.Code != 0 || owned.Data.Text != "owned OCR" {
		t.Fatalf("owned OCR response = %#v", owned)
	}
	otherSameName := serveAuthenticatedImageOCRRequest(t, router, signingKey, otherDocumentID, otherBoxID, "/api/asset/getImageOCRText", map[string]any{
		"path": ownedAssetPath,
	})
	if otherSameName.Code != 0 || otherSameName.Data.Text != "other notebook OCR" {
		t.Fatalf("same-name OCR response in other notebook = %#v", otherSameName)
	}

	for _, test := range []struct {
		name       string
		documentID string
		path       string
	}{
		{name: "same notebook unreferenced", documentID: documentID, path: unownedAssetPath},
		{name: "other notebook same path", documentID: documentID, path: crossAssetPath},
		{name: "box-bound reference cannot authorize global fallback", documentID: documentID, path: boundGlobalPath},
		{name: "invented document identity", documentID: fakeDocumentID, path: ownedAssetPath},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := serveAuthenticatedImageOCRRequest(t, router, signingKey, test.documentID, ownedBoxID, "/api/asset/setImageOCRText", map[string]any{
				"path": test.path,
				"text": "forbidden mutation",
			})
			if result.Code == 0 {
				t.Fatalf("unbound OCR mutation response = %#v", result)
			}
		})
	}
	if util.GetAssetText(unownedKey) != "unowned OCR" || util.GetAssetText(crossKey) != "cross OCR" || util.GetAssetText(ownedKey) != "owned OCR" {
		t.Fatal("an unbound service-auth OCR request mutated persisted text")
	}
}

func imageOCRServiceAuthRouter(t *testing.T, configuration *serviceauth.Configuration) *gin.Engine {
	t.Helper()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	router := gin.New()
	router.Use(configuration.Middleware(), ContentResponseLifecycle)
	router.POST("/api/asset/getImageOCRText", getImageOCRText)
	router.POST("/api/asset/setImageOCRText", setImageOCRText)
	return router
}

func serveAuthenticatedImageOCRRequest(
	t *testing.T,
	router *gin.Engine,
	signingKey ed25519.PrivateKey,
	documentID,
	notebookID,
	requestPath string,
	payload map[string]any,
) imageOCRHTTPResult {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode authenticated OCR request: %v", err)
	}
	now := time.Now()
	claims := serviceauth.Claims{
		SpaceID: imageOCRServiceSpaceID,
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{imageOCRServiceInstanceID},
			ExpiresAt: jwt.NewNumericDate(now.Add(20 * time.Second)),
			ID:        imageOCRServiceRequestID,
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "singularity-api",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = imageOCRServiceKeyID
	signedToken, err := token.SignedString(signingKey)
	if err != nil {
		t.Fatalf("sign authenticated OCR request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, requestPath, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(serviceauth.DocumentIDHeader, documentID)
	request.Header.Set(serviceauth.NotebookIDHeader, notebookID)
	request.Header.Set(serviceauth.RequestIDHeader, imageOCRServiceRequestID)
	request.Header.Set(serviceauth.ServiceTokenHeader, signedToken)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	var result imageOCRHTTPResult
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode authenticated OCR response [status=%d]: %v", response.Code, err)
	}
	return result
}

func createImageOCRDocumentFixture(t *testing.T, boxID, documentID string, assetPaths []string) {
	t.Helper()
	treePath := "/" + documentID + ".sy"
	tree := treenode.NewTree(boxID, treePath, "/OCR Contract", "OCR Contract")
	tree.ID = documentID
	tree.Root.ID = documentID
	tree.Root.SetIALAttr("id", documentID)
	tree.Root.SetIALAttr("updated", documentID[:14])
	if tree.Root.FirstChild != nil {
		tree.Root.FirstChild.Unlink()
	}
	paragraph := &ast.Node{Type: ast.NodeParagraph, ID: documentID[:14] + "-ocrpara", Box: boxID, Path: treePath}
	paragraph.SetIALAttr("id", paragraph.ID)
	paragraph.SetIALAttr("updated", paragraph.ID[:14])
	for _, assetPath := range assetPaths {
		image := &ast.Node{Type: ast.NodeImage}
		image.AppendChild(&ast.Node{Type: ast.NodeLinkDest, Tokens: []byte(assetPath)})
		paragraph.AppendChild(image)
	}
	tree.Root.AppendChild(paragraph)
	if err := model.PerformTxSync(&model.Transaction{
		Notebook: model.TransactionNotebookForBox(boxID),
		DoOperations: []*model.Operation{{
			Action: "create",
			Data:   tree,
		}},
	}); err != nil {
		t.Fatalf("create OCR document fixture: %v", err)
	}
}

func writeImageOCRAssetFixture(t *testing.T, boxID, assetPath string) string {
	t.Helper()
	absPath := filepath.Join(util.DataDir, boxID, filepath.FromSlash(assetPath))
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		t.Fatalf("create OCR asset fixture directory: %v", err)
	}
	if err := os.WriteFile(absPath, []byte("not-an-image"), 0600); err != nil {
		t.Fatalf("write OCR asset fixture: %v", err)
	}
	return absPath
}

func mustImageOCRAssetKey(t *testing.T, absPath string) string {
	t.Helper()
	key, err := util.AssetTextKeyFromAbsPath(absPath)
	if err != nil {
		t.Fatalf("derive OCR asset key: %v", err)
	}
	return key
}

func newImageOCRServiceAuthConfiguration(t *testing.T) (*serviceauth.Configuration, ed25519.PrivateKey) {
	t.Helper()
	tempDir := t.TempDir()
	certificatePath := filepath.Join(tempDir, "server.crt")
	privateKeyPath := filepath.Join(tempDir, "server.key")
	clientCAPath := filepath.Join(tempDir, "client-ca.crt")
	keyRingPath := filepath.Join(tempDir, "service-keys.json")

	certificatePublicKey, certificatePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate OCR service TLS key: %v", err)
	}
	certificate := &x509.Certificate{
		BasicConstraintsValid: true,
		DNSNames:              []string{"gateway.internal"},
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		NotAfter:              time.Now().Add(time.Hour),
		NotBefore:             time.Now().Add(-time.Minute),
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "gateway.internal"},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, certificate, certificate, certificatePublicKey, certificatePrivateKey)
	if err != nil {
		t.Fatalf("create OCR service TLS certificate: %v", err)
	}
	certificatePEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER})
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(certificatePrivateKey)
	if err != nil {
		t.Fatalf("encode OCR service TLS key: %v", err)
	}
	if err = os.WriteFile(certificatePath, certificatePEM, 0600); err != nil {
		t.Fatalf("write OCR service TLS certificate: %v", err)
	}
	if err = os.WriteFile(privateKeyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKeyDER}), 0600); err != nil {
		t.Fatalf("write OCR service TLS key: %v", err)
	}
	if err = os.WriteFile(clientCAPath, certificatePEM, 0600); err != nil {
		t.Fatalf("write OCR service client CA: %v", err)
	}

	signingPublicKey, signingPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate OCR service signing key: %v", err)
	}
	publicKeyDER, err := x509.MarshalPKIXPublicKey(signingPublicKey)
	if err != nil {
		t.Fatalf("encode OCR service signing key: %v", err)
	}
	keyRing, err := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kid":          imageOCRServiceKeyID,
			"publicKeyPem": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicKeyDER})),
		}},
	})
	if err != nil {
		t.Fatalf("encode OCR service key ring: %v", err)
	}
	if err = os.WriteFile(keyRingPath, keyRing, 0600); err != nil {
		t.Fatalf("write OCR service key ring: %v", err)
	}

	environment := map[string]string{
		"SINGULARITY_KERNEL_ENTERPRISE":              "1",
		"SINGULARITY_KERNEL_GATEWAY_CLIENT_DNS_NAME": "gateway.internal",
		"SINGULARITY_KERNEL_INSTANCE_ID":             imageOCRServiceInstanceID,
		"SINGULARITY_KERNEL_LISTEN_ADDRESS":          "127.0.0.1",
		"SINGULARITY_KERNEL_SERVICE_KEYS_FILE":       keyRingPath,
		"SINGULARITY_KERNEL_SPACE_ID":                imageOCRServiceSpaceID,
		"SINGULARITY_KERNEL_TLS_CERT_FILE":           certificatePath,
		"SINGULARITY_KERNEL_TLS_KEY_FILE":            privateKeyPath,
		"SINGULARITY_KERNEL_CLIENT_CA_FILE":          clientCAPath,
	}
	configuration, err := serviceauth.Load(func(name string) (string, bool) {
		value, found := environment[name]
		return value, found
	})
	if err != nil {
		t.Fatalf("load OCR service authentication: %v", err)
	}
	return configuration, signingPrivateKey
}
