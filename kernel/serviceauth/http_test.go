package serviceauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/util"
)

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
