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

package mcp

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	kernelapi "github.com/siyuan-note/siyuan/kernel/api"
	"github.com/siyuan-note/siyuan/kernel/mcp/tools"
	"github.com/siyuan-note/siyuan/kernel/model"
)

func Serve(ginServer *gin.Engine) {
	// MCP 工具暴露任意工作区文件读写删、SQL、插件分发等管理级原语，必须要求管理员角色，
	// 否则 Publish 匿名模式注入的 RoleReader JWT 可经此链路越权调用全部工具。
	ginServer.POST("/mcp", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, handlePost)
	ginServer.GET("/mcp", model.CheckAuth, model.CheckAdminRole, func(c *gin.Context) {
		c.Status(http.StatusMethodNotAllowed)
	})
	ginServer.DELETE("/mcp", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, handleDelete)
}

func handlePost(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusOK, JsonRpcErrorResponse{
			JsonRpc: "2.0",
			Error:   RpcError{Code: -32700, Message: "Parse error"},
			ID:      nil,
		})
		return
	}

	var req JsonRpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		c.JSON(http.StatusOK, JsonRpcErrorResponse{
			JsonRpc: "2.0",
			Error:   RpcError{Code: -32700, Message: "Parse error"},
			ID:      nil,
		})
		return
	}

	if req.JsonRpc != "2.0" {
		c.JSON(http.StatusOK, JsonRpcErrorResponse{
			JsonRpc: "2.0",
			Error:   RpcError{Code: -32600, Message: "Invalid Request"},
			ID:      req.ID,
		})
		return
	}

	if req.Method == "" {
		c.JSON(http.StatusOK, JsonRpcErrorResponse{
			JsonRpc: "2.0",
			Error:   RpcError{Code: -32600, Message: "Invalid Request"},
			ID:      req.ID,
		})
		return
	}
	protoVersion := c.GetHeader("MCP-Protocol-Version")
	if protoVersion == ProtocolV20260728 {
		handlePost2026(c, &req)
		return
	}

	var session *Session
	if req.Method == "initialize" {
		session = newSession()
	} else {
		sessionID := c.GetHeader("Mcp-Session-Id")
		if sessionID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Mcp-Session-Id required"})
			return
		}
		session = getSession(sessionID)
		if session == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
			return
		}
	}
	if !prepareContentResponse(c, &req) {
		return
	}

	response := processRequest(&req, session, protoVersion, callContextForRequest(c))

	if req.Method == "initialize" {
		c.Header("Mcp-Session-Id", session.ID)
	}

	writeResponse(c, response)
}

func prepareContentResponse(c *gin.Context, req *JsonRpcRequest) bool {
	if err := registerContentResponse(c, req); err != nil {
		writeResponse(c, &JsonRpcErrorResponse{
			JsonRpc: "2.0",
			Error:   RpcError{Code: -32603, Message: err.Error()},
			ID:      req.ID,
		})
		return false
	}
	return true
}

func registerContentResponse(c *gin.Context, req *JsonRpcRequest) error {
	if req.Method != "tools/call" || req.ID == nil {
		return nil
	}
	params, ok := req.Params.(map[string]any)
	if !ok {
		return nil
	}
	toolName, _ := params["name"].(string)
	args, _ := params["arguments"].(map[string]any)
	if args == nil {
		return nil
	}
	action, _ := args["action"].(string)

	switch toolName {
	case "export":
		switch action {
		case "md", "html", "preview", "docx":
			notebook, _, err := tools.NotebookArg(args)
			if err != nil {
				return err
			}
			return kernelapi.RegisterEncryptedResponse(c, notebook)
		case "sy", "md-zip":
			_, _, err := tools.NotebookArg(args)
			return err
		}
	case "document":
		if action == "list" {
			notebook, provided, err := tools.NotebookArg(args)
			if err != nil {
				return err
			}
			if !provided {
				return fmt.Errorf("notebook is required")
			}
			return kernelapi.RegisterEncryptedResponse(c, notebook)
		}
	case "history":
		switch action {
		case "list", "search":
			notebook, provided, err := tools.NotebookArg(args)
			if err != nil {
				return err
			}
			if !provided {
				return kernelapi.RegisterAllEncryptedResponses(c)
			}
			return kernelapi.RegisterEncryptedResponse(c, notebook)
		case "get":
			notebook, err := tools.HistoricalNotebookArg(args, false)
			if err != nil {
				return err
			}
			return kernelapi.RegisterEncryptedResponse(c, notebook)
		}
	}
	return nil
}

func callContextForRequest(c *gin.Context) tools.CallContext {
	return tools.CallContext{
		RegisterEncryptedResponses: func(boxIDs []string) error {
			return kernelapi.RegisterEncryptedResponses(c, boxIDs)
		},
	}
}

func handlePost2026(c *gin.Context, req *JsonRpcRequest) {
	mcpMethod := c.GetHeader("Mcp-Method")
	if mcpMethod != "" && mcpMethod != req.Method {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Mcp-Method header does not match body method"})
		return
	}
	if !prepareContentResponse(c, req) {
		return
	}

	response := processRequest2026(req, callContextForRequest(c))
	writeResponse(c, response)
}

func writeResponse(c *gin.Context, response any) {
	switch v := response.(type) {
	case nil:
		c.Status(http.StatusAccepted)
	case *JsonRpcResponse:
		c.JSON(http.StatusOK, v)
	case *JsonRpcErrorResponse:
		c.JSON(http.StatusOK, v)
	}
}

func handleDelete(c *gin.Context) {
	sessionID := c.GetHeader("Mcp-Session-Id")
	if sessionID == "" {
		c.Status(http.StatusBadRequest)
		return
	}
	removeSession(sessionID)
	c.Status(http.StatusOK)
}
