package serviceauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
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
