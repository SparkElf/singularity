package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/collab"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/serviceauth"
)

var enterpriseCollaboration = collab.NewProductionCoordinator()

type enterpriseCollaborationRequest struct {
	Action      string                    `json:"action"`
	FeatureMode collab.FeatureMode        `json:"featureMode,omitempty"`
	Identity    collab.DocumentIdentity   `json:"identity"`
	Envelope    *collab.OperationEnvelope `json:"envelope,omitempty"`
}

// EnterpriseCollaboration handles the mTLS-only semantic bridge used by the API coordinator.
// Content identity is parsed once by serviceauth middleware; Kernel owns encryption admission and history.
func EnterpriseCollaboration(c *gin.Context) {
	contentIdentity, ok := serviceauth.RequestContentIdentity(c.Request)
	if !ok {
		c.AbortWithStatus(http.StatusForbidden)
		return
	}
	var request enterpriseCollaborationRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	if request.Identity.OrganizationID != contentIdentity.OrganizationID || request.Identity.SpaceID != contentIdentity.SpaceID || request.Identity.NotebookID != contentIdentity.NotebookID || request.Identity.DocumentID != contentIdentity.DocumentID {
		c.JSON(http.StatusBadRequest, gin.H{"code": "missing-identity"})
		return
	}
	encrypted := model.IsEncryptedBox(contentIdentity.NotebookID)
	unlocked := model.IsBoxUnlocked(contentIdentity.NotebookID)
	switch request.Action {
	case "admit":
		admission, err := enterpriseCollaboration.Admit(request.Identity, request.FeatureMode, encrypted, unlocked)
		if err != nil {
			if errors.Is(err, collab.ErrEncryptedCollaborationUnavailable) {
				c.JSON(http.StatusConflict, gin.H{"code": "encrypted-collaboration-unavailable"})
				return
			}
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": admission})
	case "apply":
		if request.Envelope == nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": "missing-identity"})
			return
		}
		if request.Envelope.Identity != request.Identity {
			c.JSON(http.StatusBadRequest, gin.H{"code": "missing-identity"})
			return
		}
		applied, err := enterpriseCollaboration.Apply(*request.Envelope, request.FeatureMode, encrypted, unlocked)
		if err != nil {
			if errors.Is(err, collab.ErrEncryptedCollaborationUnavailable) {
				c.JSON(http.StatusConflict, gin.H{"code": "encrypted-collaboration-unavailable"})
				return
			}
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": applied})
	case "replay":
		entries, err := enterpriseCollaboration.Replay(request.Identity)
		if err != nil {
			if errors.Is(err, collab.ErrEncryptedCollaborationUnavailable) {
				c.JSON(http.StatusConflict, gin.H{"code": "encrypted-collaboration-unavailable"})
				return
			}
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": gin.H{"entries": entries}})
	default:
		c.AbortWithStatus(http.StatusBadRequest)
	}
}
