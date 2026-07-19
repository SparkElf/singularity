// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/siyuan-note/siyuan/kernel/util"
)

const enterpriseShareAssetMaxBytes = 100 * 1024 * 1024

var ErrEnterpriseShareDocumentNotFound = errors.New("enterprise shared document not found")
var ErrEnterpriseShareAssetNotFound = errors.New("enterprise shared asset not found")

type EnterpriseSharedAssetDescriptor struct {
	AssetID     string `json:"assetId"`
	Disposition string `json:"disposition"`
	FileName    string `json:"fileName"`
	MediaType   string `json:"mediaType"`
}

type EnterpriseSharedDocument struct {
	Assets     []*EnterpriseSharedAssetDescriptor `json:"assets"`
	DocumentID string                             `json:"documentId"`
	HTML       string                             `json:"html"`
	Title      string                             `json:"title"`
}

type EnterpriseSharedAsset struct {
	Data        []byte
	Disposition string
	FileName    string
	MediaType   string
}

type enterpriseShareAsset struct {
	descriptor *EnterpriseSharedAssetDescriptor
	path       string
}

func VerifyEnterpriseSharedDocument(notebookID, documentID string) bool {
	release := holdEnterpriseShareRead(notebookID)
	defer release()
	_, err := loadEnterpriseSharedDocument(notebookID, documentID)
	return err == nil
}

func ReadEnterpriseSharedDocument(notebookID, documentID string) (*EnterpriseSharedDocument, error) {
	release := holdEnterpriseShareRead(notebookID)
	defer release()
	tree, err := loadEnterpriseSharedDocument(notebookID, documentID)
	if err != nil {
		return nil, err
	}
	assets := enterpriseShareAssets(notebookID, documentID, tree.Root)
	assetIDs := make(map[string]string, len(assets))
	descriptors := make([]*EnterpriseSharedAssetDescriptor, 0, len(assets))
	for _, asset := range assets {
		assetIDs[asset.path] = asset.descriptor.AssetID
		descriptors = append(descriptors, asset.descriptor)
	}

	html := NewLute().RenderNodeBlockDOM(tree.Root)
	html, err = rewriteEnterpriseSharedAssetLinks(util.SanitizeHTML(html), assetIDs)
	if err != nil {
		return nil, fmt.Errorf("sanitize enterprise shared document: %w", err)
	}
	return &EnterpriseSharedDocument{
		Assets:     descriptors,
		DocumentID: documentID,
		HTML:       html,
		Title:      tree.Root.IALAttr("title"),
	}, nil
}

func ReadEnterpriseSharedAsset(notebookID, documentID, assetID string) (*EnterpriseSharedAsset, error) {
	release := holdEnterpriseShareRead(notebookID)
	defer release()
	tree, err := loadEnterpriseSharedDocument(notebookID, documentID)
	if err != nil {
		return nil, err
	}
	var matched *enterpriseShareAsset
	for _, asset := range enterpriseShareAssets(notebookID, documentID, tree.Root) {
		if asset.descriptor.AssetID == assetID {
			matched = asset
			break
		}
	}
	if matched == nil {
		return nil, ErrEnterpriseShareAssetNotFound
	}
	absPath, err := GetAssetAbsPathInBox(matched.path, notebookID)
	if err != nil {
		return nil, ErrEnterpriseShareAssetNotFound
	}
	stat, err := os.Lstat(absPath)
	if err != nil || !stat.Mode().IsRegular() || stat.Mode()&os.ModeSymlink != 0 || stat.Size() > enterpriseShareAssetMaxBytes {
		return nil, ErrEnterpriseShareAssetNotFound
	}
	data, err := ReadAssetBytesInBox(notebookID, matched.path)
	if err != nil || len(data) > enterpriseShareAssetMaxBytes {
		return nil, ErrEnterpriseShareAssetNotFound
	}
	return &EnterpriseSharedAsset{
		Data:        data,
		Disposition: matched.descriptor.Disposition,
		FileName:    matched.descriptor.FileName,
		MediaType:   matched.descriptor.MediaType,
	}, nil
}

func loadEnterpriseSharedDocument(notebookID, documentID string) (*parse.Tree, error) {
	if Conf.GetBox(notebookID) == nil {
		return nil, ErrEnterpriseShareDocumentNotFound
	}
	tree, err := LoadTreeByBlockIDInBox(documentID, notebookID)
	if err != nil || tree == nil || tree.Root == nil || tree.Root.ID != documentID || tree.Box != notebookID {
		return nil, ErrEnterpriseShareDocumentNotFound
	}
	return tree, nil
}

func holdEnterpriseShareRead(notebookID string) func() {
	if !IsEncryptedBox(notebookID) {
		return func() {}
	}
	HoldBoxReadLock(notebookID)
	return func() { ReleaseBoxReadLock(notebookID) }
}

func enterpriseShareAssets(notebookID, documentID string, root *ast.Node) []*enterpriseShareAsset {
	unique := map[string]struct{}{}
	for _, rawPath := range getAssetsLinkDests(root, false) {
		assetPath := AssetPathWithoutQuery(rawPath)
		if !strings.HasPrefix(assetPath, "assets/") {
			continue
		}
		unique[assetPath] = struct{}{}
	}
	paths := make([]string, 0, len(unique))
	for assetPath := range unique {
		paths = append(paths, assetPath)
	}
	sort.Strings(paths)
	assets := make([]*enterpriseShareAsset, 0, len(paths))
	for _, assetPath := range paths {
		mediaType := mime.TypeByExtension(strings.ToLower(filepath.Ext(assetPath)))
		if mediaType == "" {
			mediaType = "application/octet-stream"
		}
		disposition := "attachment"
		if enterpriseShareInlineMediaType(mediaType) {
			disposition = "inline"
		}
		assets = append(assets, &enterpriseShareAsset{
			descriptor: &EnterpriseSharedAssetDescriptor{
				AssetID:     enterpriseShareAssetID(notebookID, documentID, assetPath),
				Disposition: disposition,
				FileName:    filepath.Base(assetPath),
				MediaType:   mediaType,
			},
			path: assetPath,
		})
	}
	return assets
}

func enterpriseShareAssetID(notebookID, documentID, assetPath string) string {
	digest := sha256.New()
	digest.Write([]byte("singularity.enterprise-share-asset.v1"))
	digest.Write([]byte{0})
	digest.Write([]byte(notebookID))
	digest.Write([]byte{0})
	digest.Write([]byte(documentID))
	digest.Write([]byte{0})
	digest.Write([]byte(assetPath))
	return hex.EncodeToString(digest.Sum(nil))
}

func enterpriseShareInlineMediaType(mediaType string) bool {
	baseType, _, err := mime.ParseMediaType(mediaType)
	if err != nil {
		return false
	}
	switch baseType {
	case "image/avif", "image/gif", "image/jpeg", "image/png", "image/webp",
		"audio/mpeg", "audio/ogg", "audio/wav", "video/mp4", "video/ogg", "video/webm":
		return true
	default:
		return false
	}
}

func rewriteEnterpriseSharedAssetLinks(source string, assetIDs map[string]string) (string, error) {
	context := &nethtml.Node{Type: nethtml.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := nethtml.ParseFragment(strings.NewReader(source), context)
	if err != nil {
		return "", err
	}
	for _, node := range nodes {
		rewriteEnterpriseSharedAssetNode(node, assetIDs)
	}
	var output bytes.Buffer
	for _, node := range nodes {
		if err = nethtml.Render(&output, node); err != nil {
			return "", err
		}
	}
	return output.String(), nil
}

func rewriteEnterpriseSharedAssetNode(node *nethtml.Node, assetIDs map[string]string) {
	if node.Type == nethtml.ElementNode {
		attrs := node.Attr[:0]
		for _, attr := range node.Attr {
			if attr.Key != "href" && attr.Key != "poster" && attr.Key != "src" {
				attrs = append(attrs, attr)
				continue
			}
			assetPath := strings.TrimPrefix(AssetPathWithoutQuery(attr.Val), "/")
			if assetID := assetIDs[assetPath]; assetID != "" {
				attr.Val = "singularity-share-asset:" + assetID
				attrs = append(attrs, attr)
				continue
			}
			if attr.Key == "href" && enterpriseShareExternalLink(attr.Val) {
				attrs = append(attrs, attr)
			}
		}
		node.Attr = attrs
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		rewriteEnterpriseSharedAssetNode(child, assetIDs)
	}
}

func enterpriseShareExternalLink(value string) bool {
	if strings.HasPrefix(value, "#") {
		return true
	}
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		return parsed.Host != "" && parsed.User == nil
	case "mailto":
		return parsed.Opaque != ""
	default:
		return false
	}
}
