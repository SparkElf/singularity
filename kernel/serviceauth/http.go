package serviceauth

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const (
	OrganizationIDHeader = "X-Singularity-Organization-Id"
	SpaceIDHeader        = "X-Singularity-Space-Id"
	DocumentIDHeader     = "X-Singularity-Document-Id"
	NotebookIDHeader     = "X-Singularity-Notebook-Id"
	RequestIDHeader      = "X-Singularity-Request-Id"
	ServiceTokenHeader   = "X-Singularity-Service-Token"
)

type authenticationContextKey struct{}
type contentIdentityContextKey struct{}

var contentIDPattern = regexp.MustCompile(`^\d{14}-[0-9a-z]{7}$`)
var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type RouteIdentityRequirement uint8

const (
	ContentIdentityRequired RouteIdentityRequirement = iota
	ServiceIdentityRequired
	QueryIdentityRequired
	FullContentIdentityRequired
)

type routeKey struct {
	method string
	path   string
}

type ContentIdentity struct {
	OrganizationID string
	SpaceID        string
	DocumentID     string
	NotebookID     string
}

// RegisterRoute 将Gin路由与身份要求作为一个声明注册，避免路径与认证策略分离。
func (configuration *Configuration) RegisterRoute(
	routes gin.IRoutes,
	method string,
	path string,
	identity RouteIdentityRequirement,
	handlers ...gin.HandlerFunc,
) {
	if identity > FullContentIdentityRequired || len(handlers) == 0 {
		panic("enterprise route identity declaration is invalid")
	}
	key := routeKey{method: method, path: path}
	if _, exists := configuration.routeIdentities[key]; exists {
		panic("enterprise route identity declaration is duplicated")
	}
	configuration.routeIdentities[key] = identity
	routes.Handle(method, path, handlers...)
}

func parseContentIdentity(request *http.Request) (ContentIdentity, bool) {
	notebookIDs := request.Header.Values(NotebookIDHeader)
	documentIDs := request.Header.Values(DocumentIDHeader)
	if len(notebookIDs) != 1 || len(documentIDs) != 1 {
		return ContentIdentity{}, false
	}
	notebookID := strings.TrimSpace(notebookIDs[0])
	documentID := strings.TrimSpace(documentIDs[0])
	if notebookID != notebookIDs[0] || documentID != documentIDs[0] || !contentIDPattern.MatchString(notebookID) || !contentIDPattern.MatchString(documentID) {
		return ContentIdentity{}, false
	}
	return ContentIdentity{DocumentID: documentID, NotebookID: notebookID}, true
}

// parseFullContentIdentity 是协作私有路由的四段身份 owner，缺任一头部即在 Kernel 入口拒绝。
func parseFullContentIdentity(request *http.Request) (ContentIdentity, bool) {
	identity, ok := parseContentIdentity(request)
	if !ok {
		return ContentIdentity{}, false
	}
	organizationIDs := request.Header.Values(OrganizationIDHeader)
	spaceIDs := request.Header.Values(SpaceIDHeader)
	if len(organizationIDs) != 1 || len(spaceIDs) != 1 {
		return ContentIdentity{}, false
	}
	organizationID := strings.TrimSpace(organizationIDs[0])
	spaceID := strings.TrimSpace(spaceIDs[0])
	if organizationID != organizationIDs[0] || spaceID != spaceIDs[0] || !uuidPattern.MatchString(organizationID) || !uuidPattern.MatchString(spaceID) {
		return ContentIdentity{}, false
	}
	identity.OrganizationID = organizationID
	identity.SpaceID = spaceID
	return identity, true
}

func (configuration *Configuration) Middleware() gin.HandlerFunc {
	return func(ginContext *gin.Context) {
		requestID := ginContext.GetHeader(RequestIDHeader)
		_, err := configuration.verifier.Verify(
			ginContext.GetHeader(ServiceTokenHeader),
			requestID,
			time.Now(),
		)
		if err != nil {
			logging.LogWarnf("kernel.route service authentication failed [requestId=%s]", requestID)
			ginContext.AbortWithStatus(http.StatusUnauthorized)
			return
		}

		requestContext := context.WithValue(ginContext.Request.Context(), authenticationContextKey{}, true)
		identityRequirement := ContentIdentityRequired
		if declared, exists := configuration.routeIdentities[routeKey{
			method: ginContext.Request.Method,
			path:   ginContext.FullPath(),
		}]; exists {
			identityRequirement = declared
		}
		if identityRequirement == ContentIdentityRequired || identityRequirement == FullContentIdentityRequired {
			identity, identityOK := parseContentIdentity(ginContext.Request)
			if identityRequirement == FullContentIdentityRequired {
				identity, identityOK = parseFullContentIdentity(ginContext.Request)
			}
			if !identityOK {
				logging.LogWarnf("kernel.route content identity failed [requestId=%s]", requestID)
				ginContext.AbortWithStatus(http.StatusBadRequest)
				return
			}
			requestContext = context.WithValue(requestContext, contentIdentityContextKey{}, identity)
		}
		ginContext.Request = ginContext.Request.WithContext(requestContext)
		ginContext.Set(model.RoleContextKey, model.RoleAdministrator)
		ginContext.Next()
	}
}

func RequestContentIdentity(request *http.Request) (ContentIdentity, bool) {
	identity, ok := request.Context().Value(contentIdentityContextKey{}).(ContentIdentity)
	return identity, ok
}

func Authenticated(request *http.Request) bool {
	authenticated, _ := request.Context().Value(authenticationContextKey{}).(bool)
	return authenticated
}

func (configuration *Configuration) ReadyHandler(version string) gin.HandlerFunc {
	return func(ginContext *gin.Context) {
		if !Authenticated(ginContext.Request) {
			ginContext.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		if !util.IsBooted() {
			ginContext.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		ginContext.Header("Cache-Control", "no-store")
		ginContext.JSON(http.StatusOK, map[string]string{
			"kernelInstanceId": configuration.instanceID,
			"status":           "ready",
			"version":          version,
		})
	}
}
