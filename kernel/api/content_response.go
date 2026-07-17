// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package api

import (
	"fmt"
	"slices"
	"sort"

	"github.com/88250/lute/ast"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
)

const encryptedResponseLifecycleContextKey = "siyuan.encrypted-response-lifecycle"

type encryptedResponseLifecycle struct {
	boxIDs              []string
	managedClaims       []*model.ManagedEncryptedExportClaim
	cryptoControlLocked bool
}

func ContentResponseLifecycle(c *gin.Context) {
	lifecycle := &encryptedResponseLifecycle{}
	c.Set(encryptedResponseLifecycleContextKey, lifecycle)
	defer lifecycle.release()
	c.Next()
}

func (lifecycle *encryptedResponseLifecycle) register(boxIDs []string) error {
	if lifecycle.cryptoControlLocked {
		return fmt.Errorf("encrypted response content scope is already registered")
	}
	unique := map[string]struct{}{}
	for _, boxID := range boxIDs {
		if boxID != "" && model.IsEncryptedBox(boxID) {
			unique[boxID] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(unique))
	for boxID := range unique {
		ordered = append(ordered, boxID)
	}
	sort.Strings(ordered)
	if len(ordered) == 0 {
		return nil
	}
	if slices.Equal(lifecycle.boxIDs, ordered) {
		return nil
	}
	if len(lifecycle.boxIDs) != 0 {
		return fmt.Errorf("one response cannot replace its encrypted notebook content scope")
	}
	for _, boxID := range ordered {
		model.HoldBoxResponseReadLock(boxID)
		lifecycle.boxIDs = append(lifecycle.boxIDs, boxID)
	}
	return nil
}

func (lifecycle *encryptedResponseLifecycle) release() {
	for i := len(lifecycle.managedClaims) - 1; i >= 0; i-- {
		claim := lifecycle.managedClaims[i]
		if err := claim.Close(); err != nil {
			logging.LogWarnf("close managed export response claim for notebook [%s] failed: %s", claim.BoxID, err)
		}
	}
	lifecycle.managedClaims = nil
	for i := len(lifecycle.boxIDs) - 1; i >= 0; i-- {
		model.ReleaseBoxResponseReadLock(lifecycle.boxIDs[i])
	}
	lifecycle.boxIDs = nil
	if lifecycle.cryptoControlLocked {
		lifecycle.cryptoControlLocked = false
		model.NotebookCryptoMuUnlock()
	}
}

func RegisterEncryptedResponse(c *gin.Context, boxID string) error {
	return RegisterEncryptedResponses(c, []string{boxID})
}

func RegisterEncryptedResponses(c *gin.Context, boxIDs []string) error {
	value, ok := c.Get(encryptedResponseLifecycleContextKey)
	if !ok {
		return fmt.Errorf("encrypted response lifecycle is not installed")
	}
	lifecycle, ok := value.(*encryptedResponseLifecycle)
	if !ok || lifecycle == nil {
		return fmt.Errorf("encrypted response lifecycle is invalid")
	}
	return lifecycle.register(boxIDs)
}

// RetainManagedEncryptedExportClaim transfers claim cleanup to the outer
// response lifecycle so its response gate covers compression and transport
// writes that happen after the route handler returns.
func RetainManagedEncryptedExportClaim(c *gin.Context, claim *model.ManagedEncryptedExportClaim) error {
	if claim == nil {
		return fmt.Errorf("managed encrypted export claim is nil")
	}
	value, ok := c.Get(encryptedResponseLifecycleContextKey)
	if !ok {
		return fmt.Errorf("encrypted response lifecycle is not installed")
	}
	lifecycle, ok := value.(*encryptedResponseLifecycle)
	if !ok || lifecycle == nil {
		return fmt.Errorf("encrypted response lifecycle is invalid")
	}
	lifecycle.managedClaims = append(lifecycle.managedClaims, claim)
	return nil
}

func RegisterAllEncryptedResponses(c *gin.Context) error {
	value, ok := c.Get(encryptedResponseLifecycleContextKey)
	if !ok {
		return fmt.Errorf("encrypted response lifecycle is not installed")
	}
	lifecycle, ok := value.(*encryptedResponseLifecycle)
	if !ok || lifecycle == nil {
		return fmt.Errorf("encrypted response lifecycle is invalid")
	}
	if lifecycle.cryptoControlLocked || len(lifecycle.boxIDs) != 0 {
		return fmt.Errorf("encrypted response content scope is already registered")
	}

	// 多笔记本聚合固定按控制面锁、排序后的响应锁获取，并持有到 JSON 写入完成。
	model.NotebookCryptoMuLock()
	lifecycle.cryptoControlLocked = true
	boxIDs := model.ListAllEncryptedBoxIDs()
	ordered := append([]string(nil), boxIDs...)
	sort.Strings(ordered)
	for i, boxID := range ordered {
		if i > 0 && ordered[i-1] == boxID {
			continue
		}
		model.HoldBoxResponseReadLock(boxID)
		lifecycle.boxIDs = append(lifecycle.boxIDs, boxID)
	}
	return nil
}

func encryptedNotebookForResponse(c *gin.Context, arg map[string]any) (string, error) {
	boxID, err := encryptedNotebookFromArg(arg)
	if err != nil || boxID == "" {
		return boxID, err
	}
	if err = RegisterEncryptedResponse(c, boxID); err != nil {
		return "", err
	}
	return boxID, nil
}

// declaredNotebookForResponse preserves the caller's notebook identity for
// ownership validation while only encrypted notebooks acquire a response gate.
func declaredNotebookForResponse(c *gin.Context, arg map[string]any) (string, error) {
	if _, provided := arg["notebook"]; !provided {
		return "", nil
	}
	notebook, err := requiredNotebookFromArg(arg)
	if err != nil {
		return "", err
	}
	if model.Conf.GetBox(notebook) == nil {
		return "", fmt.Errorf("%w: %s", model.ErrBoxNotFound, notebook)
	}
	if err = RegisterEncryptedResponse(c, notebook); err != nil {
		return "", err
	}
	return notebook, nil
}

func requiredNotebookForResponse(c *gin.Context, arg map[string]any) (string, error) {
	notebook, err := requiredNotebookFromArg(arg)
	if err != nil {
		return "", err
	}
	if err = RegisterEncryptedResponse(c, notebook); err != nil {
		return "", err
	}
	return notebook, nil
}

func historicalNotebookForResponse(c *gin.Context, arg map[string]any, allowGlobal bool) (string, error) {
	value, provided := arg["notebook"]
	if !provided {
		return "", fmt.Errorf("%w: notebook", model.ErrInvalidID)
	}
	notebook, ok := value.(string)
	if !ok || (notebook == "" && !allowGlobal) || (notebook != "" && !ast.IsNodeIDPattern(notebook)) {
		return "", fmt.Errorf("%w: notebook", model.ErrInvalidID)
	}
	if notebook != "" && model.IsEncryptedBox(notebook) {
		if err := RegisterEncryptedResponse(c, notebook); err != nil {
			return "", err
		}
	}
	return notebook, nil
}
