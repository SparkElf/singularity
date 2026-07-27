package serviceauth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestParseFullContentIdentityRequiresAllFourSegments(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/internal/enterprise/collaboration", nil)
	request.Header.Set(OrganizationIDHeader, "11111111-1111-4111-8111-111111111111")
	request.Header.Set(SpaceIDHeader, "22222222-2222-4222-8222-222222222222")
	request.Header.Set(NotebookIDHeader, "20260722090000-bookabc")
	request.Header.Set(DocumentIDHeader, "20260722090001-docabcd")
	identity, ok := parseFullContentIdentity(request)
	if !ok {
		t.Fatal("full content identity was rejected")
	}
	if identity.OrganizationID == "" || identity.SpaceID == "" || identity.NotebookID == "" || identity.DocumentID == "" {
		t.Fatalf("full content identity = %#v", identity)
	}

	request.Header.Del(SpaceIDHeader)
	if _, ok := parseFullContentIdentity(request); ok {
		t.Fatal("full content identity without space was accepted")
	}
}

func TestMiddlewareBindsFullContentIdentityToConfiguredSpace(t *testing.T) {
	const (
		instanceID = "11111111-1111-4111-8111-111111111111"
		spaceID    = "22222222-2222-4222-8222-222222222222"
		requestID  = "33333333-3333-4333-8333-333333333333"
		keyID      = "serviceauth-http-test"
	)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate service signing key: %v", err)
	}
	configuration := &Configuration{
		instanceID:      instanceID,
		routeIdentities: make(map[routeKey]RouteIdentityRequirement),
		spaceID:         spaceID,
		verifier:        NewVerifier(instanceID, spaceID, map[string]ed25519.PublicKey{keyID: publicKey}),
	}
	router := gin.New()
	router.Use(configuration.Middleware())
	configuration.RegisterRoute(router, http.MethodPost, "/internal/test", FullContentIdentityRequired, func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})
	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, Claims{
		SpaceID: spaceID,
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{instanceID},
			ExpiresAt: jwt.NewNumericDate(now.Add(20 * time.Second)),
			ID:        requestID,
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    serviceTokenIssuer,
		},
	})
	token.Header["kid"] = keyID
	signedToken, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign service token: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/internal/test", nil)
	request.Header.Set(ServiceTokenHeader, signedToken)
	request.Header.Set(RequestIDHeader, requestID)
	request.Header.Set(OrganizationIDHeader, "44444444-4444-4444-8444-444444444444")
	request.Header.Set(SpaceIDHeader, "55555555-5555-4555-8555-555555555555")
	request.Header.Set(NotebookIDHeader, "20260722090000-bookabc")
	request.Header.Set(DocumentIDHeader, "20260722090001-docabcd")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("full content identity with another space = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

func TestReadyHandlerWaitsForKernelBoot(t *testing.T) {
	gin.SetMode(gin.TestMode)
	configuration := &Configuration{instanceID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
	router := gin.New()
	router.GET("/internal/readyz", func(ginContext *gin.Context) {
		requestContext := context.WithValue(
			ginContext.Request.Context(),
			authenticationContextKey{},
			true,
		)
		ginContext.Request = ginContext.Request.WithContext(requestContext)
		configuration.ReadyHandler("3.7.2")(ginContext)
	})

	starting := httptest.NewRecorder()
	router.ServeHTTP(starting, httptest.NewRequest(http.MethodGet, "/internal/readyz", nil))
	if starting.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready status before boot = %d, want %d", starting.Code, http.StatusServiceUnavailable)
	}

	util.SetBooted()
	ready := httptest.NewRecorder()
	router.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/internal/readyz", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("ready status after boot = %d, want %d", ready.Code, http.StatusOK)
	}
}
