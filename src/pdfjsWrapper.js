import { backtrackBeforeAllVisibleElements, PDFLinkService } from 'pdfjs-dist-sig/es5/web/pdf_viewer';
import { reduceEachTrailingCommentRange } from 'typescript';

var pendingOperation = Promise.resolve();

export default function(PDFJS) {

	function isPDFDocumentLoadingTask(obj) {

		return typeof(obj) === 'object' && obj !== null && obj.__PDFDocumentLoadingTask === true;
		// or: return obj.constructor.name === 'PDFDocumentLoadingTask';
	}

	function createLoadingTask(src, options) {

		var source;
		if ( typeof(src) === 'string' )
			source = { url: src };
		else if ( src instanceof Uint8Array )
			source = { data: src };
		else if ( typeof(src) === 'object' && src !== null )
			source = Object.assign({}, src);
		else
			throw new TypeError('invalid src type');

		// source.verbosity = PDFJS.VerbosityLevel.INFOS;
		// source.pdfBug = true;
		// source.stopAtErrors = true;

		if ( options && options.withCredentials )
			source.withCredentials = options.withCredentials;

		var loadingTask = PDFJS.getDocument(source);
		loadingTask.__PDFDocumentLoadingTask = true; // since PDFDocumentLoadingTask is not public

		if ( options && options.onPassword )
			loadingTask.onPassword = options.onPassword;

		if ( options && options.onProgress )
			loadingTask.onProgress = options.onProgress;

		return loadingTask;
	}


	function PDFJSWrapper(canvasElt, annotationLayerElt, emitter) {

		var pdfDoc = null;
		var pdfPage = null;
		var pdfRender = null;
		var canceling = false;

		canvasElt.getContext('2d').save();

		function clearCanvas() {

			canvasElt.getContext('2d').clearRect(0, 0, canvasElt.width, canvasElt.height);
		}

		function clearAnnotations() {

			while ( annotationLayerElt.firstChild )
				annotationLayerElt.removeChild(annotationLayerElt.firstChild);
		}

		this.destroy = function() {

			if ( pdfDoc === null )
				return;

			// Aborts all network requests and destroys worker.
			pendingOperation = pdfDoc.destroy();
			pdfDoc = null;
		}

		this.getResolutionScale = function() {

			return canvasElt.offsetWidth / canvasElt.width;
		}

		this.printPage = function(dpi, pageNumberOnly) {

			if ( pdfPage === null )
				return;

			// 1in == 72pt
			// 1in == 96px
			var PRINT_RESOLUTION = dpi === undefined ? 150 : dpi;
			var PRINT_UNITS = PRINT_RESOLUTION / 72.0;
			var CSS_UNITS = 96.0 / 72.0;

			var iframeElt = document.createElement('iframe');

			function removeIframe() {

				iframeElt.parentNode.removeChild(iframeElt);
			}

			new Promise(function(resolve, reject) {

				iframeElt.frameBorder = '0';
				iframeElt.scrolling = 'no';
				iframeElt.width = '0px;'
				iframeElt.height = '0px;'
				iframeElt.style.cssText = 'position: absolute; top: 0; left: 0';

				iframeElt.onload = function() {

					resolve(this.contentWindow);
				}

				window.document.body.appendChild(iframeElt);
			})
			.then(function(win) {

				win.document.title = '';

				return pdfDoc.getPage(1)
				.then(function(page) {

					var viewport = page.getViewport({ scale: 1 });
					win.document.head.appendChild(win.document.createElement('style')).textContent =
						'@supports ((size:A4) and (size:1pt 1pt)) {' +
							'@page { margin: 1pt; size: ' + ((viewport.width * PRINT_UNITS) / CSS_UNITS) + 'pt ' + ((viewport.height * PRINT_UNITS) / CSS_UNITS) + 'pt; }' +
						'}' +

						'@media print {' +
							'body { margin: 0 }' +
							'canvas { page-break-before: avoid; page-break-after: always; page-break-inside: avoid }' +
						'}'+

						'@media screen {' +
							'body { margin: 0 }' +
						'}'+

						''
					return win;
				})
			})
			.then(function(win) {

				var allPages = [];

				for ( var pageNumber = 1; pageNumber <= pdfDoc.numPages; ++pageNumber ) {

					if ( pageNumberOnly !== undefined && pageNumberOnly.indexOf(pageNumber) === -1 )
						continue;

					allPages.push(
						pdfDoc.getPage(pageNumber)
						.then(function(page) {

							var viewport = page.getViewport({ scale: 1 });

							var printCanvasElt = win.document.body.appendChild(win.document.createElement('canvas'));
							printCanvasElt.width = (viewport.width * PRINT_UNITS);
							printCanvasElt.height = (viewport.height * PRINT_UNITS);

							return page.render({
								canvasContext: printCanvasElt.getContext('2d'),
								transform: [ // Additional transform, applied just before viewport transform.
									PRINT_UNITS, 0, 0,
									PRINT_UNITS, 0, 0
								],
								viewport: viewport,
								intent: 'print'
							}).promise;
						})
					);
				}

				Promise.all(allPages)
				.then(function() {

					win.focus(); // Required for IE
					if (win.document.queryCommandSupported('print')) {
						win.document.execCommand('print', false, null);
						} else {
						win.print();
					  }
					removeIframe();
				})
				.catch(function(err) {

					removeIframe();
					emitter.emit('error', err);
				})
			})
		}

		this.renderPage = function(rotate) {
			if ( pdfRender !== null ) {

				if ( canceling )
					return;
				canceling = true;
				pdfRender.cancel();
				return;
			}

			if ( pdfPage === null )
				return;

			var pageRotate = (pdfPage.rotate === undefined ? 0 : pdfPage.rotate) + (rotate === undefined ? 0 : rotate);

			var scale = canvasElt.offsetWidth / pdfPage.getViewport({ scale: 1 }).width * (window.devicePixelRatio || 1);
			var viewport = pdfPage.getViewport({ scale: scale, rotation:pageRotate });

			emitter.emit('page-size', { width: viewport.width, height: viewport.height, scale });

			canvasElt.width = viewport.width;
			canvasElt.height = viewport.height;

			pdfRender = pdfPage.render({
				canvasContext: canvasElt.getContext('2d'),
				viewport: viewport
			});

			annotationLayerElt.style.visibility = 'hidden';
			clearAnnotations();

			var viewer = {
				scrollPageIntoView: function(params) {
					emitter.emit('link-clicked', params.pageNumber)
				},
			};

			var linkService = new PDFLinkService();
			linkService.setDocument(pdfDoc);
			linkService.setViewer(viewer);

			pendingOperation = pendingOperation.then(function() {

				var getAnnotationsOperation =
				pdfPage.getAnnotations({ intent: 'display' })
				.then(function(annotations) {

					PDFJS.AnnotationLayer.render({
						viewport: viewport.clone({ dontFlip: true }),
						div: annotationLayerElt,
						annotations: annotations,
						page: pdfPage,
						linkService: linkService,
						renderInteractiveForms: false
					});
				});

				var pdfRenderOperation =
				pdfRender.promise
				.then(function() {

					annotationLayerElt.style.visibility = '';
					canceling = false;
					pdfRender = null;
				})
				.catch(function(err) {

					pdfRender = null;
					if ( err instanceof PDFJS.RenderingCancelledException ) {

						canceling = false;
						this.renderPage(rotate);
						return;
					}
					emitter.emit('error', err);
				}.bind(this))

				return Promise.all([getAnnotationsOperation, pdfRenderOperation]);
			}.bind(this));
		}


		this.renderPageScale = function(scaleA) {
			var scalex
			var w = pdfPage._pageInfo.view[2]
			var h = pdfPage._pageInfo.view[3]
		  var desiredWidth
			var scrollWidth = 10
			switch (scaleA.action) {
				case 'page_scale_auto':
				case 'page_scale_actual':
					scalex = w / h
					desiredWidth = window.document.getElementsByClassName('modal-content')[0].getBoundingClientRect()['width'] - scrollWidth
					break
				case 'page_scale_fit':
					var newH = window.document.getElementsByClassName('modal-content')[0].getBoundingClientRect()['height'] - window.document.getElementsByClassName('wrapperCanvas')[0].getBoundingClientRect()['x']
					desiredWidth = newH * w / h
					break
				case 'page_scale_width':
					desiredWidth = window.document.getElementsByClassName('wrapperCanvas')[0].clientWidth - scrollWidth
					break
				case 'page_scale_percent':
					if (scaleA.args !== null) {
						scalex = scaleA.args.scale
						var clientWidth = window.document.getElementsByClassName('wrapperCanvas')[0].clientWidth - scrollWidth
						desiredWidth = clientWidth * scalex / 100
					}
					break
			}

			var basicviewport = pdfPage.getViewport({ scale: 1, });
			var scale = desiredWidth / basicviewport.width;
			var viewport = pdfPage.getViewport({ scale: scale, });

			emitter.emit(
				'page-size',
				{ width: viewport.width, height: viewport.height , scale }
			);
			canvasElt.height = viewport.height;
			canvasElt.width = viewport.width;
			pdfRender = pdfPage.render({
				canvasContext: canvasElt.getContext('2d'),
				viewport: viewport
			});

			return
		}


		this.forEachPage = function(pageCallback) {

			var numPages = pdfDoc.numPages;

			(function next(pageNum) {

				pdfDoc.getPage(pageNum)
				.then(pageCallback)
				.then(function() {

					if ( ++pageNum <= numPages )
						next(pageNum);
				})
			})(1);
		}


		this.loadPage = function(pageNumber, rotate) {
			pdfPage = null;

			if ( pdfDoc === null )
				return;

			pendingOperation = pendingOperation.then(function() {

				return pdfDoc.getPage(pageNumber);
			})
			.then(function(page) {

				pdfPage = page;
				this.renderPageScale({action: 'page_scale_width', args: {}});
				emitter.emit('page-loaded', page.pageNumber);
			}.bind(this))
			.catch(function(err) {

				clearCanvas();
				clearAnnotations();
				emitter.emit('error', err);
			});
		}

		this.loadDocument = function(src) {

			pdfDoc = null;
			pdfPage = null;

			emitter.emit('num-pages', undefined);

			if ( !src ) {

				canvasElt.removeAttribute('width');
				canvasElt.removeAttribute('height');
				clearAnnotations();
				return;
			}

			// wait for pending operation ends
			pendingOperation = pendingOperation.then(function() {

				var loadingTask;
				if ( isPDFDocumentLoadingTask(src) ) {

					if ( src.destroyed ) {

						emitter.emit('error', new Error('loadingTask has been destroyed'));
						return
					}

					loadingTask = src;
				} else {

					loadingTask = createLoadingTask(src, {
						onPassword: function(updatePassword, reason) {

							var reasonStr;
							switch (reason) {
								case PDFJS.PasswordResponses.NEED_PASSWORD:
									reasonStr = 'NEED_PASSWORD';
									break;
								case PDFJS.PasswordResponses.INCORRECT_PASSWORD:
									reasonStr = 'INCORRECT_PASSWORD';
									break;
							}
							emitter.emit('password', updatePassword, reasonStr);
						},
						onProgress: function(status) {

							var ratio = status.loaded / status.total;
							emitter.emit('progress', Math.min(ratio, 1));
						}
					});
				}

				return loadingTask.promise;
			})
			.then(function(pdf) {

				pdfDoc = pdf;
				emitter.emit('num-pages', pdf.numPages);
				emitter.emit('loaded');
			})
			.catch(function(err) {

				clearCanvas();
				clearAnnotations();
				emitter.emit('error', err);
			})
		}

		annotationLayerElt.style.transformOrigin = '0 0';
	}

	return {
		createLoadingTask: createLoadingTask,
		PDFJSWrapper: PDFJSWrapper,
	}
}
