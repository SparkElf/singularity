// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package api

import (
	"encoding/base64"
	"errors"
	"mime"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/serviceauth"
	"github.com/siyuan-note/siyuan/kernel/util"
)

const enterpriseBackupDigestHeader = "X-Singularity-Backup-Sha256"

var enterpriseSHA256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type enterpriseObservationResponse struct {
	Capacity enterpriseCapacityResponse   `json:"capacity"`
	Health   model.EnterpriseHealthSample `json:"health"`
}

type enterpriseCapacityResponse struct {
	AssetBytes                 string    `json:"assetBytes"`
	DataBytes                  string    `json:"dataBytes"`
	ErrorCode                  string    `json:"errorCode,omitempty"`
	FileCount                  string    `json:"fileCount"`
	SampleDurationMilliseconds int64     `json:"sampleDurationMilliseconds"`
	SampledAt                  time.Time `json:"sampledAt"`
}

func EnterpriseVerifySharedDocument(c *gin.Context) {
	identity, ok := enterpriseContentIdentity(c)
	if !ok {
		return
	}
	if model.VerifyEnterpriseSharedDocument(identity.NotebookID, identity.DocumentID) {
		c.JSON(http.StatusOK, map[string]bool{"exists": true})
		return
	}
	c.JSON(http.StatusNotFound, map[string]bool{"exists": false})
}

func EnterpriseReadSharedDocument(c *gin.Context) {
	identity, ok := enterpriseContentIdentity(c)
	if !ok {
		return
	}
	document, err := model.ReadEnterpriseSharedDocument(identity.NotebookID, identity.DocumentID)
	if err != nil {
		enterpriseModelError(c, err, model.ErrEnterpriseShareDocumentNotFound, "share.document")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.JSON(http.StatusOK, document)
}

func EnterpriseReadSharedAsset(c *gin.Context) {
	identity, ok := enterpriseContentIdentity(c)
	if !ok {
		return
	}
	assetID := c.Query("assetId")
	if !enterpriseSHA256Pattern.MatchString(assetID) {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	asset, err := model.ReadEnterpriseSharedAsset(identity.NotebookID, identity.DocumentID, assetID)
	if err != nil {
		enterpriseModelError(c, err, model.ErrEnterpriseShareAssetNotFound, "share.asset")
		return
	}
	disposition := mime.FormatMediaType(asset.Disposition, map[string]string{"filename": asset.FileName})
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", disposition)
	c.Header("Content-Length", strconv.Itoa(len(asset.Data)))
	c.Header("Content-Type", asset.MediaType)
	c.Header("X-Singularity-Asset-Disposition", asset.Disposition)
	c.Header("X-Singularity-Asset-Filename", base64.RawURLEncoding.EncodeToString([]byte(asset.FileName)))
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, asset.MediaType, asset.Data)
}

func EnterpriseCreateBackupHandler(sourceSpaceID string) gin.HandlerFunc {
	return func(c *gin.Context) {
		archive, err := model.CreateEnterpriseBackupArchive(sourceSpaceID)
		if err != nil {
			logging.LogErrorf("backup.job create archive failed: %s", err)
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		defer os.Remove(archive.ArchivePath)
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Length", strconv.FormatInt(archive.SizeBytes, 10))
		c.Header("Content-Type", "application/zip")
		c.Header(enterpriseBackupDigestHeader, archive.SHA256)
		c.Header("X-Singularity-Backup-Format-Version", strconv.Itoa(archive.Manifest.FormatVersion))
		c.Header("X-Singularity-Kernel-Version", archive.Manifest.KernelVersion)
		c.File(archive.ArchivePath)
	}
}

func EnterpriseReadObservation(c *gin.Context) {
	sample := model.GetEnterpriseObservationSample()
	if sample == nil {
		c.Header("Cache-Control", "no-store")
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, &enterpriseObservationResponse{
		Capacity: enterpriseCapacityResponse{
			AssetBytes:                 strconv.FormatInt(sample.Capacity.AssetBytes, 10),
			DataBytes:                  strconv.FormatInt(sample.Capacity.DataBytes, 10),
			ErrorCode:                  sample.Capacity.ErrorCode,
			FileCount:                  strconv.FormatInt(sample.Capacity.FileCount, 10),
			SampleDurationMilliseconds: sample.Capacity.SampleDurationMilliseconds,
			SampledAt:                  sample.Capacity.SampledAt,
		},
		Health: sample.Health,
	})
}

func enterpriseContentIdentity(c *gin.Context) (serviceauth.ContentIdentity, bool) {
	// ContentIdentityRequired 由 serviceauth.Middleware 声明并解析；此处只处理
	// 加密内容响应生命周期，不重复检查已收敛的上下文身份。
	identity, _ := serviceauth.RequestContentIdentity(c.Request)
	if model.IsEncryptedBox(identity.NotebookID) {
		if err := RegisterEncryptedResponse(c, identity.NotebookID); err != nil {
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return serviceauth.ContentIdentity{}, false
		}
	}
	return identity, true
}

func enterpriseModelError(c *gin.Context, err error, notFoundError error, operation string) {
	if errors.Is(err, notFoundError) {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	requestID := c.GetHeader(serviceauth.RequestIDHeader)
	// 避免把文件系统和解析细节写入 Kernel 日志；请求 ID 仍可关联控制面的访问记录。
	logging.LogErrorf("kernel.route enterprise handler failed [requestId=%s, operation=%s]", requestID, operation)
	c.AbortWithStatus(http.StatusServiceUnavailable)
}
